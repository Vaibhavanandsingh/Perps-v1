import express from "express";
import type {Request , Response} from "express"
import z from "zod"
import { db } from "./src/prisma/db";
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"


const app = express();
app.use(express.json());

const jwt_secret_key = process.env.JWT_SECRET_KEY || "hello"

interface Usercollateral{
available : number,
locked : number
}

interface UserPosition{
    market : string,
    type : string,
    qty : number,
    margin : number,
    pnl : number | null,
    liquidationPrice : number,
    averagePrice : number
}

interface UserOrder{
    orderId: number,
    market : string,
    type : string,
    qty : number,
    margin : number,
    orderType : string,
    price : number | null,
    status : string
}

interface User{
    userId : number,
    username : string,
    collateral : Usercollateral,
    positions : UserPosition[],
    orders : UserOrder[]
}

type Bid = {
    availableQty: number,
    openOrders: { userId: number, qty: number, filledQty: number, orderId: number, createdAt: Date }[]
}

type Orderbook = {
    bids: Record<string, Bid>,
    asks: Record<string, Bid>,
    lastTradedPrice: number,
    indexPrice: number
}

type Orderbooks = Record<string, Orderbook>


type fill = {
    makerOrderId : number,
    takerOrderId: number,
    makerId : number,
    takerId : number,
    market : string,
    qty : number,
    price : number,
    long : number,
    short : number
}


const users : User[] = [];

const fills : fill[]= [];

function settleUserPositionAndCollateral(
  userObj: User,
  market: string,
  type: "LONG" | "SHORT",
  filledQty: number,
  executionPrice: number,
  totalOrderQty: number,
  allocatedMargin: number
){
    let position = userObj.positions.find((p: any) => p.market === market);

    if(!position){
        const proRatedMargin = allocatedMargin * (filledQty / totalOrderQty);
        const mmr = 0.05; // 5% Maintenance Margin Ratio
        const imr = 0.10; // 10% Initial Margin Ratio

        const liquidationPrice =
        type === "LONG"
            ? executionPrice * (1 - imr + mmr)
            : executionPrice * (1 + imr - mmr);

        userObj.positions.push({
        market,
        type,
        qty: filledQty,
        margin: proRatedMargin,
        liquidationPrice,
        pnl : 0,
        averagePrice: executionPrice
        });
    }
    else if(position.type === type){
        const proRatedMargin = allocatedMargin * (filledQty / totalOrderQty);
        const newTotalQty = position.qty + filledQty;

        position.averagePrice =
        (position.qty * position.averagePrice + filledQty * executionPrice) / newTotalQty;
        position.qty = newTotalQty;
        position.margin += proRatedMargin;
    }
    else{
        const closeQty = Math.min(position.qty, filledQty);

        const pnlPerUnit =
        position.type === "LONG"
            ? executionPrice - position.averagePrice
            : position.averagePrice - executionPrice;

        const realizedPnL = closeQty * pnlPerUnit;
        const releasedMargin = position.margin * (closeQty / position.qty);

        userObj.collateral.locked -= releasedMargin;
        userObj.collateral.available += releasedMargin + realizedPnL;

        position.qty -= closeQty;
        position.margin -= releasedMargin;

        if (position.qty <= 0) {
        userObj.positions = userObj.positions.filter((p: any) => p.market !== market);
        }
    }
}

function insertIntoOrderbook(marketBook: any, order: any, remainingQty: number, userId: number) {
  const side = order.type === "LONG" ? marketBook.bids : marketBook.asks;
  const priceKey = order.price.toString();

  if (!side[priceKey]) {
    side[priceKey] = {
      availableQty: 0,
      openOrders: []
    };
  }

  side[priceKey].availableQty += remainingQty;
  side[priceKey].openOrders.push({
    userId: userId,
    qty: order.qty,
    filledQty: order.qty - remainingQty,
    orderId: order.orderId,
    createdAt: new Date()
  });
}

const orderbooks: Orderbooks = {
     SOL: { bids: {}, asks: {}, lastTradedPrice: 90, indexPrice: 90.01 },
     ETH: { bids: {}, asks: {}, lastTradedPrice: 1900, indexPrice: 1899.9 }
}

const createUserSchema = z.object({
    username : z.string().min(8).max(16),
    password : z.string().min(8).max(16)
})

app.post("/signup", async(req : Request, res : Response) => {
    const result = createUserSchema.safeParse(req.body)

    if(!result.success){
        return res.status(400).json({ success : false , error : result.error })
    }

    const {username , password} = result.data

    let isUsernameUnique

    try {
       isUsernameUnique = await db.orm.public.User.where({ username }).first() 
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal server error" , error})
    }


    if(isUsernameUnique){
        return res.status(400).json({ success : false , message : "Username is not unique"})
    }

    let passwordHash

    try {
        passwordHash = await bcrypt.hash(password , 10)
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal server error" , error})
    }

    let user

    try {
        user = await db.orm.public.User.create({
            username ,
            password
        })
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal server error" , error})
    }

    return res.status(200).json({ success : true , message : "User Created"})
})

app.post("/signin", async (req : Request , res : Response) => {
    const {username , password} = req.body

    if(!username || !password){
        return res.status(400).json({ success : false , message : "Invalid values"})
    }

    let user

    try {
        user = await db.orm.public.User.where({username : username}).first()
    } catch (error) {
        return res.status(500).json({ success : false , message : "Error connecting to the db" , error})
    }

    if(!user){
        return res.status(400).json({ success : false , message : "No such user with this username exists"})
    }

    const userId = user.id
    let isPasswordCorrect

    try {
        isPasswordCorrect = await bcrypt.compare(password , user.password)
    } catch (error) {
        return res.status(500).json({ success : false , message:"Internal Server Error"})
    }

    if(!isPasswordCorrect){
        return res.status(400).json({ success : false , message : "Password is Incorrect"})
    }

    let token

    const tokenPayload = {
            username,
            userId
        }

    try {
        token = await jwt.sign(tokenPayload , jwt_secret_key)
    } catch (error) {
        return res.status(400).json({ success : false , message : "Internal Server Error"})
    }

    return res.status(200).json({ success : true , message : "User Signed in" , token})
})

const createOrderSchema = z.object({
   price : z.number().nullable(),
   qty : z.number(),
   type : z.enum(["LONG", "SHORT"]),
   equity : z.number(),
   market : z.string(),
   orderType : z.enum(["limit" , "market"])
})

app.post("/order", async(req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization
    const result =  createOrderSchema.safeParse(req.body)

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload

    if(!result.success){
        return res.status(400).json({ success : false , message : "Invalid value input" , error : result.error})
    }

    let {price , qty , type , equity , market , orderType} = result.data

    let marketOrderBook = orderbooks[market]

    if(!marketOrderBook){
        return res.status(400).json({success : false , message : "No such market exist"})
    }

    if(qty <= 0){
        return res.status(400).json({ success : false , message : "Qty cant be zero or negative"})
    }

    if(equity <= 0){
        return res.status(400).json({ success : false , message : "equity cant be zero or negative"})
    }

    if(orderType === "limit" && (!price || price <= 0)){
        return res.status(400).json({ success : false , message : "Limit order price cant be null"})
    }

    const user = users.find((u) => u.userId === userId)

    if(!user){
        return res.status(401).json({ success : false , message : "User not found"})
    }

    const userPostions = user.positions
 
    const marketPostion = userPostions.find((p) => p.market === market)

    let requiredMargin

    if(!marketPostion || marketPostion.type === type){
        requiredMargin = equity
    }
    else{
        if(qty > marketPostion.qty){
            requiredMargin = equity * ((qty - marketPostion.qty)/qty)
        }
        else{
            requiredMargin = 0
        }
    }

    if(user.collateral.available < requiredMargin){
        return res.status(400).json({ success : false , message : `Insufficient available balance. Required: ${requiredMargin}, Available: ${user.collateral.available}`})
    }

    user.collateral.available -= requiredMargin;
    user.collateral.locked += requiredMargin;

    let maxOrderId = 0

    users.forEach((user) => {
        user.orders.forEach((order) => {
            if( order.orderId > maxOrderId) maxOrderId = order.orderId
        })
    })

    const newOrder : UserOrder = {
        orderId : maxOrderId + 1,
        market,
        type,
        qty,
        margin : requiredMargin,
        orderType,
        price : orderType === "limit" ? price : null,
        status : "open"
    }

    user.orders.push(newOrder)

    const isLong = type === "LONG"

    const opposingSide = isLong ? marketOrderBook.asks : marketOrderBook.bids

    const sortedPrices = Object.keys(opposingSide).map(Number).sort((a , b) => isLong ? a - b : b - a)

    let unexecutedQty = qty
    let totalCost = 0
    let executedQty = 0

    for(const matchPrice of sortedPrices){
        if(unexecutedQty <= 0) break

        if(orderType === "limit" && price !== null){
            if(isLong && matchPrice > price) break
            if(!isLong && matchPrice < price) break
        }

        const priceLevel = opposingSide[matchPrice]

        if(!priceLevel || priceLevel.availableQty <= 0) continue

        for(const makerOrder of priceLevel.openOrders){
            if(unexecutedQty <= 0) break

            const makerAvailable = makerOrder.qty - makerOrder.filledQty
            if(makerAvailable <= 0)continue

            const matchQty = Math.min(unexecutedQty, makerAvailable);

            makerOrder.filledQty += matchQty;
            priceLevel.availableQty -= matchQty;
            unexecutedQty -= matchQty;
            executedQty += matchQty;
            totalCost += matchQty * matchPrice;

            fills.push({
                makerOrderId : makerOrder.orderId,
                takerOrderId : newOrder.orderId,
                makerId : makerOrder.userId,
                takerId : user.userId,
                market,
                qty : matchQty,
                price : matchPrice,
                long : isLong ? user.userId : makerOrder.userId,
                short : isLong ? makerOrder.userId : user.userId
            })

            const makerUser = users.find((user) => user.userId === makerOrder.userId)
            if(makerUser){
                settleUserPositionAndCollateral(
                    makerUser,
                    market,
                    type,
                    matchQty,
                    matchPrice,
                    makerOrder.qty,
                    requiredMargin
                )

                 if (makerOrder.filledQty === makerOrder.qty) {
                    const mOrderObj = makerUser?.orders.find((o) => o.orderId === makerOrder.orderId);
                    if (mOrderObj) mOrderObj.status = "filled";
                }
            }

            settleUserPositionAndCollateral(
                user,
                market,
                type,
                matchQty,
                matchPrice,
                qty,
                requiredMargin
            );
        }
    }


    const avgExecutionPrice = executedQty > 0 ? totalCost / executedQty : 0;

    if (executedQty > 0) {
    marketOrderBook.lastTradedPrice = sortedPrices[0]!;
    }

    if (unexecutedQty === 0) {
    newOrder.status = "filled";
    newOrder.price = avgExecutionPrice;
    } 
    else if (executedQty > 0) {
    if (orderType === "market") {
        newOrder.status = "filled";
        newOrder.price = avgExecutionPrice;

        const unusedMargin = requiredMargin * (unexecutedQty / qty);
        user.collateral.locked -= unusedMargin;
        user.collateral.available += unusedMargin;
    } 
    else 
    {
        insertIntoOrderbook(marketOrderBook, newOrder, unexecutedQty, user.userId);
    }
    } else {
    if (orderType === "market") {
        newOrder.status = "cancelled";

        user.collateral.locked -= requiredMargin;
        user.collateral.available += requiredMargin;
    } else {
        insertIntoOrderbook(marketOrderBook, newOrder, unexecutedQty, user.userId);
    }
    }
})

app.delete("/order", async(req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload
    const {orderId , market} = req.body

    const user = users.find((u) => u.userId === userId)
    if (!user) {
    return res.status(404).json({ success: false, message: "User not found" });
    }

    const orderIndex = user.orders.findIndex((o) => o.orderId === orderId && o.status === "open")

    if(orderIndex === -1){
        return res.status(404).json({ success : false , message : "Open order Not found"})
    }

    const targetOrder = user.orders[orderIndex];

    if (!targetOrder) {
      return res.status(404).json({ success: false, message: "Open order not found" });
    }

    const marketBook = orderbooks[market];
    
        if (!marketBook) {
        return res.status(400).json({ success: false, message: "Market does not exist" });
        }

    const side = targetOrder.type === "LONG" ? marketBook.asks : marketBook.bids
    const priceKey = targetOrder.price?.toString() ?? "-1"
    const priceLevel = side[priceKey]

    let unfilledQty = targetOrder.qty;

    if(priceLevel){
        const bookOrderIndex = priceLevel.openOrders.findIndex((o) => o.orderId === orderId);

    if (bookOrderIndex !== -1) {
      const bookOrder = priceLevel.openOrders[bookOrderIndex];

      if (!bookOrder) {
        return res.status(404).json({ success: false, message: "Order not found in order book" });
      }

      unfilledQty = bookOrder.qty - bookOrder.filledQty;

      priceLevel.availableQty -= unfilledQty;
      priceLevel.openOrders.splice(bookOrderIndex, 1);

      if (priceLevel.availableQty <= 0 || priceLevel.openOrders.length === 0) {
        delete side[priceKey];
      }
    }
    }

    const marginToUnlock = targetOrder.margin * (unfilledQty / targetOrder.qty);
    user.collateral.locked -= marginToUnlock;
    user.collateral.available += marginToUnlock;

    targetOrder.status = "cancelled";

    return res.status(200).json({
        success: true,
        message: "Order cancelled successfully",
        orderId: targetOrder.orderId,
        unlockedMargin: marginToUnlock
    });
})

app.post("/onramp", async(req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization
    const result =  createOrderSchema.safeParse(req.body)

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload
    
    const user = users.find((u) => u.userId === userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const {amount} = req.body

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ success: false, message: "Amount must be a positive number" });
  }

  // Credit available collateral balance
  user.collateral.available += amount;

  return res.status(200).json({
    success: true,
    message: "Collateral deposited successfully",
    collateral: user.collateral
  });
})

app.get("/equity/available", async(req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization
    const result =  createOrderSchema.safeParse(req.body)

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload
    
    const user = users.find((u) => u.userId === userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
    success: true,
    collateral: user.collateral
  });
})

app.get("/positions/open/:marketId", async(req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization
    const result =  createOrderSchema.safeParse(req.body)

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload
    
    const user = users.find((u) => u.userId === userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const { marketId } = req.params;

    const openPositions = user.positions.filter(
        (p) => p.market === marketId && p.qty > 0
    );

    return res.status(200).json({
        success: true,
        market: marketId,
        positions: openPositions
    });
});


app.get("/positions/closed/:marketId", async (req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization
    const result =  createOrderSchema.safeParse(req.body)

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload
    
    const user = users.find((u) => u.userId === userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const { marketId } = req.params;

  // Derive closed position trades from global fills where user was long or short
  const userClosedFills = fills.filter(
    (f) => f.market === marketId && (f.long === user.userId || f.short === user.userId)
  );

  return res.status(200).json({
    success: true,
    market: marketId,
    closedFills: userClosedFills
  });
});


app.get("/orders/open/:marketId", async (req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization
    const result =  createOrderSchema.safeParse(req.body)

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload
    
    const user = users.find((u) => u.userId === userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const { marketId } = req.params;

    const openOrders = user.orders.filter(
    (o) => o.market === marketId && o.status === "open"
  );

  return res.status(200).json({
    success: true,
    market: marketId,
    orders: openOrders
  });
})


app.get("/orders/:marketId", async (req : Request, res : Response) => {
    const authorizationHeader = req.headers.authorization
    const result =  createOrderSchema.safeParse(req.body)

    if(!authorizationHeader || !authorizationHeader.startsWith("Bearer ")){
        return res.status(400).json({ success : false , message : "No valid auth token provided in the header"})
    }
    
    const token = authorizationHeader.split(" ")[1]

    if(!token){
        return res.status(400).json({ success : false , message : "No token provided "})
    }

    let authTokenPayload 

    try {
       authTokenPayload = await jwt.verify(token , jwt_secret_key) as {username : string , userId : number}
    } catch (error) {
        return res.status(500).json({ success : false , message : "Internal Server Error"})
    }

    if(!authTokenPayload){
        return res.status(400).json({ success : false , message : "Invalid Auth Token provided"})
    }

    const {username , userId} = authTokenPayload
    
    const user = users.find((u) => u.userId === userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const { marketId } = req.params;
    const marketOrders = user.orders.filter((o) => o.market === marketId);

  return res.status(200).json({
    success: true,
    market: marketId,
    orders: marketOrders
  });
})
app.get("/fills", (req, res) => {});

async function liqudationChecks(asset: string, price: number) {

}


async function onPriceUpdateFromBinance(asset: string, price: number) {
    liqudationChecks(asset, price);   
}
