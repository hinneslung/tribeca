/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />
///<reference path="../config.ts"/>
///<reference path="../utils.ts"/>
///<reference path="../interfaces.ts"/>

import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
import log from "../logging";
const shortId = require("shortid");
const Deque = require("collections/deque");

import ccxt = require('ccxt');
import GatecoinInterfaces = require('./gatecoin-api');

/**
 * Market Data Gateway
 */


interface GatecoinMarketLevel {
    price: string;
    amount: string;
}


function decodeSide(side: string) {
    switch (side) {
        case "bid": return Models.Side.Bid;
        case "ask": return Models.Side.Ask;
        default: return Models.Side.Unknown;
    }
}

function encodeSide(side: Models.Side) {
    switch (side) {
        case Models.Side.Bid: return "bid";
        case Models.Side.Ask: return "ask";
        default: return "";
    }
}

function encodeTimeInForce(tif: Models.TimeInForce, type: Models.OrderType) {
    if (type === Models.OrderType.Market) {
        return "exchange market";
    }
    else if (type === Models.OrderType.Limit) {
        if (tif === Models.TimeInForce.FOK) return "exchange fill-or-kill";
        if (tif === Models.TimeInForce.GTC) return "exchange limit";
    }
    throw new Error("unsupported tif " + Models.TimeInForce[tif] + " and order type " + Models.OrderType[type]);
}

class GatecoinMarketDataGateway implements Interfaces.IMarketDataGateway {
    /**
     * MARK
     */
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    private _since: number = null;
    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrades = (trades: Models.Timestamped<GatecoinInterfaces.Trade[]>) => {
        _.forEach(trades.data, trade => {
            let px = trade.price;
            let sz = trade.quantity;
            let time = moment.unix(parseInt(trade.transactionTime)).toDate();
            let side = decodeSide(trade.way);
            let mt = new Models.GatewayMarketTrade(px, sz, time, this._since === null, side);
            this.MarketTrade.trigger(mt);
        });

        this._since = moment().unix();
    };

    private downloadMarketTrades = () => {
        this._http.api.fetchTrades(this._symbolProvider.symbol)
            .then(res => this.onTrades(res.transactions))
    };

    private static ConvertToMarketSide(level: number[]): Models.MarketSide {
        return new Models.MarketSide(level[0], level[1])
    }

    private static ConvertToMarketSides(levels: number[][]): Models.MarketSide[] {
        return _.map(levels, GatecoinMarketDataGateway.ConvertToMarketSide);
    }

    MarketData = new Utils.Evt<Models.Market>();
    private onMarketData = (asks: number[][], bids: number[][]) => {
        let bs = GatecoinMarketDataGateway.ConvertToMarketSides(bids);
        let as = GatecoinMarketDataGateway.ConvertToMarketSides(asks);

        this.MarketData.trigger(new Models.Market(bs, as, new Date()));
    };

    private downloadMarketData = () => {
        this._http.api.fetchOrderBook(this._symbolProvider.symbol)
            .then(res => this.onMarketData(res.asks, res.bids))
            .done();
    };

    constructor(
        timeProvider: Utils.ITimeProvider,
        private _http: GatecoinHttp,
        private _symbolProvider: GatecoinSymbolProvider) {

        timeProvider.setInterval(this.downloadMarketData, moment.duration(5, "seconds"));
        timeProvider.setInterval(this.downloadMarketTrades, moment.duration(15, "seconds"));

        this.downloadMarketData();
        this.downloadMarketTrades();

        _http.ConnectChanged.on(s => this.ConnectChanged.trigger(s));
    }
}

/**
 * Order Entry Gateway
 */


class GatecoinOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    supportsCancelAllOpenOrders = () : boolean => { return false; };
    cancelAllOpenOrders = () : Q.Promise<number> => { return Q(0); };

    generateClientOrderId = () => shortId.generate();

    public cancelsByClientOrderId = false;

    sendOrder = (order: Models.OrderStatusReport) => {
        (order.side === Models.Side.Bid ?
            this._http.api.createLimitBuyOrder(this._symbolProvider.symbol, order.quantity, order.price) :
            this._http.api.createLimitSellOrder(this._symbolProvider.symbol, order.quantity, order.price)
        )
            .then(res => {
                this.OrderUpdate.trigger({
                    orderId: order.orderId,
                    exchangeId: res.id,
                    time: new Date(),
                    orderStatus: Models.OrderStatus.Working
                });
            })
            .catch(err => {
                this.OrderUpdate.trigger({
                    orderStatus: Models.OrderStatus.Rejected,
                    orderId: order.orderId,
                    rejectMessage: err,
                    time: new Date()
                });
                return;
            })
            .done();

        this.OrderUpdate.trigger({
            orderId: order.orderId,
            computationalLatency: Utils.fastDiff(new Date(), order.time)
        });
    };

    cancelOrder = (cancel: Models.OrderStatusReport) => {
        this._http.api.cancelOrder(cancel.exchangeId)
            .then(resp => {
                this.OrderUpdate.trigger({
                    orderId: cancel.orderId,
                    time: new Date(),
                    orderStatus: Models.OrderStatus.Cancelled
                });
            })
            .catch(err => {
                this.OrderUpdate.trigger({
                    orderStatus: Models.OrderStatus.Rejected,
                    cancelRejected: true,
                    orderId: cancel.orderId,
                    rejectMessage: err,
                    time: new Date()
                });
            })
            .done();

        this.OrderUpdate.trigger({
            orderId: cancel.orderId,
            computationalLatency: Utils.fastDiff(new Date(), cancel.time)
        });
    };

    replaceOrder = (replace: Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    };

    private downloadOrderStatuses = () => {
        this._http.api.fetchMyOrders()
            .then(res => {
                _.forEach(res.orders.data, order => {
                    this.OrderUpdate.trigger({
                        exchangeId: order.clOrderId,
                        lastPrice: order.price,
                        orderStatus: GatecoinOrderEntryGateway.decodeOrderStatus(order.statusDesc),
                        cumQuantity: order.remainingQuantity,
                        quantity: order.initialQuantity
                    })
                });
            }).done();

        this._since = moment.utc();
    };

    private static decodeOrderStatus(status: string) {
        if (status === 'New') return Models.OrderStatus.New;
        if (status === 'Working') return Models.OrderStatus.Working;
        return Models.OrderStatus.Other;
    }

    private _since = moment.utc();
    private _log = log("tribeca:gateway:GatecoinOE");
    constructor(
        timeProvider: Utils.ITimeProvider,
        private _details: GatecoinBaseGateway,
        private _http: GatecoinHttp,
        private _symbolProvider: GatecoinSymbolProvider) {

        _http.ConnectChanged.on(s => this.ConnectChanged.trigger(s));
        timeProvider.setInterval(this.downloadOrderStatuses, moment.duration(8, "seconds"));
    }
}

/**
 * HTTP / API / ccxt
 */

class RateLimitMonitor {
    private _log = log("tribeca:gateway:rlm");

    private _queue = Deque();
    private _durationMs: number;

    public add = () => {
        let now = moment.utc();

        while (now.diff(this._queue.peek()) > this._durationMs) {
            this._queue.shift();
        }

        this._queue.push(now);

        if (this._queue.length > this._number) {
            this._log.error("Exceeded rate limit", { nRequests: this._queue.length, max: this._number, durationMs: this._durationMs });
        }
    };

    constructor(private _number: number, duration: moment.Duration) {
        this._durationMs = duration.asMilliseconds();
    }
}

class GatecoinHttp {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    api: GatecoinInterfaces.API;
    private _timeout = 15000;

    private _log = log("tribeca:gateway:GatecoinHTTP");
    private _apiKey: string;
    private _secret: string;

    constructor(config: Config.IConfigProvider, private _monitor: RateLimitMonitor) {
        this._apiKey = config.GetString("GatecoinKey");
        this._secret = config.GetString("GatecoinSecret");

        this.api = ccxt.gatecoin({
           apiKey: this._apiKey,
           secret: this._secret
        });

        setTimeout(() => this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected), 10);
    }
}

/**
 * Position Gateway
 */

interface GatecoinPositionResponseItem {
    type: string;
    currency: string;
    amount: string;
    available: string;
}

class GatecoinPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private onRefreshPositions = () => {
        this._http.api.fetchBalance()
            .then(res => {
                Object.keys(res).forEach(key => {
                    let balance = res[key];
                    let cur = Models.toCurrency(key);
                    let amt = balance.total;
                    let held = balance.used;
                    let rpt = new Models.CurrencyPosition(amt, held, cur);
                    this.PositionUpdate.trigger(rpt);
                });
            })
            .done();
    };

    private _log = log("tribeca:gateway:GatecoinPG");
    constructor(timeProvider: Utils.ITimeProvider, private _http: GatecoinHttp) {
        timeProvider.setInterval(this.onRefreshPositions, moment.duration(15, "seconds"));
        this.onRefreshPositions();
    }
}

class GatecoinBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name(): string {
        return "Gatecoin";
    }

    makeFee(): number {
        return 0.0025;
    }

    takeFee(): number {
        return 0.0035;
    }

    exchange(): Models.Exchange {
        return Models.Exchange.Gatecoin;
    }

    constructor(public minTickIncrement: number) {}
}

class GatecoinSymbolProvider {
    public symbol: string;

    constructor(pair: Models.CurrencyPair) {
        this.symbol = pair.toString();
    }
}

class Gatecoin extends Interfaces.CombinedGateway {
    constructor(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, symbol: GatecoinSymbolProvider, pricePrecision: number) {
        const monitor = new RateLimitMonitor(60, moment.duration(1, "minutes"));
        const http = new GatecoinHttp(config, monitor);
        const details = new GatecoinBaseGateway(pricePrecision);

        const orderGateway = config.GetString("GatecoinOrderDestination") == "Gatecoin"
            ? <Interfaces.IOrderEntryGateway>new GatecoinOrderEntryGateway(timeProvider, details, http, symbol)
            : new NullGateway.NullOrderGateway();

        super(
            new GatecoinMarketDataGateway(timeProvider, http, symbol),
            orderGateway,
            new GatecoinPositionGateway(timeProvider, http),
            details);
    }
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

let countDecimals = function (value) {
    if(Math.floor(value) === value) return 0;
    return value.toString().split(".")[1].length || 0;
};

export async function createGatecoin(timeProvider: Utils.ITimeProvider, config: Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    const detailsUrl = config.GetString("GatecoinHttpUrl")+"/symbols_details";
    const symbolDetails = await Utils.getJSON<SymbolDetails[]>(detailsUrl);
    const symbol = new GatecoinSymbolProvider(pair);

    for (let s of symbolDetails) {
        if (s.symbol === symbol.symbol) {
            let precision = Math.max(countDecimals(s.info.open), countDecimals(s.info.high), countDecimals(s.info.low));
            return new Gatecoin(timeProvider, config, symbol, precision);
        }
    }

    throw new Error("cannot match pair to a Gatecoin Symbol " + pair.toString());
}