
import Q = require("q");
import Models = require('../../common/models');

interface RejectableResponse {
    message: string;
}

export interface Trade {
    transactionId: string;
    transactionTime: string;
    price: number;
    quantity: number;
    currencyPair: string;
    way: string;
}

interface TradesResponse {
    transactions: Models.Timestamped<Trade[]>;
}

export interface MyOrder {
    clOrderId: string,
    side: number,
    price: number;
    initialQuantity: number;
    remainingQuantity: number;
    status: number;
    statusDesc: string;
    date: string;
}

interface CreateOrderResponse extends RejectableResponse {
    id: string
}

interface MyOrdersResponse {
    orders: Models.Timestamped<MyOrder[]>;
}

export interface OrderBookResponse {
    bids: number[][];
    asks: number[][];
}

interface Balance {
    free: number;
    used: number;
    total: number;
}

interface BalanceResponse {
    USD: Balance;
    EUR: Balance;
    HKD: Balance;
    BTC: Balance;
    ETH: Balance;
}

export interface API {
    fetchBalance(): Q.Promise<BalanceResponse>;

    fetchTrades(symbol: string): Q.Promise<TradesResponse>;
    fetchOrderBook(symbol: string): Q.Promise<OrderBookResponse>;
    fetchBalance(): Q.Promise<BalanceResponse>;

    createLimitBuyOrder(symbol: string, amount: number, price: number): Q.Promise<CreateOrderResponse>;
    createLimitSellOrder(symbol: string, amount: number, price: number): Q.Promise<CreateOrderResponse>;

    fetchMyOrders(): Q.Promise<MyOrdersResponse>;
    cancelOrder(id: string): Q.Promise<any>;
}
