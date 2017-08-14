
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
    transactions: Trade[];
}

export interface MyOrder {
    clOrderId: string;
    code: string;
    side: number;
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
    orders: MyOrder[];
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

interface ExchangeDetailsResponse {
    'BCH/USD': SymbolDetails,
    'BCH/HKD': SymbolDetails,
    'ETH/USD': SymbolDetails,
    'ETH/HKD': SymbolDetails
}

interface SymbolDetails {
    symbol: string,
    info: {
        open: number;
        high: number;
        low: number;
        close: number;
    };
}

export interface API {
    loadMarkets():Promise<ExchangeDetailsResponse>
    fetchBalance(): Promise<BalanceResponse>;

    fetchTrades(symbol: string): Promise<TradesResponse>;
    fetchOrderBook(symbol: string): Promise<OrderBookResponse>;
    fetchBalance(): Q.Promise<BalanceResponse>;

    createLimitBuyOrder(symbol: string, amount: number, price: number): Promise<CreateOrderResponse>;
    createLimitSellOrder(symbol: string, amount: number, price: number): Promise<CreateOrderResponse>;

    fetchMyOpenOrders(): Promise<MyOrdersResponse>;
    cancelOrder(id: string): Promise<any>;
}
