"use strict";
module.exports = function(Promise,
                          apiRejection,
                          INTERNAL,
                          tryConvertToPromise,
                          Proxyable,
                          debug) {
var errors = require("./errors");
var TypeError = errors.TypeError;
var ASSERT = require("./assert");
var util = require("./util");
var errorObj = util.errorObj;
var tryCatch = util.tryCatch;
var yieldHandlers = [];

if (!Function[BLUEBIRD_COROUTINES]) {
    var currentCoroutine = null;
    var o = {};
    Object.defineProperty(o, "currentCoroutine", {
        set: function(val) {
            currentCoroutine = val;
        },
        get: function() {
            return currentCoroutine;
        },
        enumerable: false,
        configurable: false
    });
    Object.freeze(o);

    Object.defineProperty(Function, BLUEBIRD_COROUTINES, {
        value: o,
        writable: false,
        enumerable: false,
        configurable: false
    });
}
var coroutines = Function[BLUEBIRD_COROUTINES];

function promiseFromYieldHandler(value, yieldHandlers, traceParent) {
    for (var i = 0; i < yieldHandlers.length; ++i) {
        traceParent._pushContext();
        var result = tryCatch(yieldHandlers[i])(value);
        traceParent._popContext();
        if (result === errorObj) {
            traceParent._pushContext();
            var ret = Promise.reject(errorObj.e);
            traceParent._popContext();
            return ret;
        }
        var maybePromise = tryConvertToPromise(result, traceParent);
        if (maybePromise instanceof Promise) return maybePromise;
    }
    return null;
}

function PromiseSpawn(generatorFunction, receiver, yieldHandler, stack) {
    if (debug.cancellation()) {
        var internal = new Promise(INTERNAL);
        var _finallyPromise = this._finallyPromise = new Promise(INTERNAL);
        this._promise = internal.lastly(function() {
            return _finallyPromise;
        });
        internal._captureStackTrace();
        internal._setOnCancel(this);
    } else {
        var promise = this._promise = new Promise(INTERNAL);
        promise._captureStackTrace();
    }
    this._stack = stack;
    this._generatorFunction = generatorFunction;
    this._receiver = receiver;
    this._generator = undefined;
    this._yieldHandlers = typeof yieldHandler === "function"
        ? [yieldHandler].concat(yieldHandlers)
        : yieldHandlers;
    this._yieldedPromise = null;
    this._cancellationPhase = false;
    this._defers = [];
}
util.inherits(PromiseSpawn, Proxyable);

PromiseSpawn.prototype._isResolved = function() {
    return this._promise === null;
};

PromiseSpawn.prototype._cleanup = function() {
    this._promise = this._generator = null;
    if (debug.cancellation() && this._finallyPromise !== null) {
        this._finallyPromise._fulfill();
        this._finallyPromise = null;
    }
};

PromiseSpawn.prototype._promiseCancelled = function() {
    if (this._isResolved()) return;
    var implementsReturn = typeof this._generator["return"] !== "undefined";

    var result;
    if (!implementsReturn) {
        var reason = new Promise.CancellationError(
            "generator .return() sentinel");
        Promise.coroutine.returnSentinel = reason;
        this._promise._attachExtraTrace(reason);
        this._promise._pushContext();
        coroutines.currentCoroutine = this;
        result = tryCatch(this._generator["throw"]).call(this._generator,
                                                         reason);
        coroutines.currentCoroutine = null;
        this._promise._popContext();
    } else {
        this._promise._pushContext();
        coroutines.currentCoroutine = this;
        result = tryCatch(this._generator["return"]).call(this._generator,
                                                          undefined);
        coroutines.currentCoroutine = null;
        this._promise._popContext();
    }
    this._cancellationPhase = true;
    this._yieldedPromise = null;
    this._continue(result);
};

PromiseSpawn.prototype._promiseFulfilled = function(value) {
    this._yieldedPromise = null;
    this._promise._pushContext();
    coroutines.currentCoroutine = this;
    var result = tryCatch(this._generator.next).call(this._generator, value);
    coroutines.currentCoroutine = null;
    this._promise._popContext();
    this._continue(result);
};

PromiseSpawn.prototype._promiseRejected = function(reason) {
    this._yieldedPromise = null;
    this._promise._attachExtraTrace(reason);
    this._promise._pushContext();
    coroutines.currentCoroutine = this;
    var result = tryCatch(this._generator["throw"])
        .call(this._generator, reason);
    coroutines.currentCoroutine = null;
    this._promise._popContext();
    this._continue(result);
};

PromiseSpawn.prototype._resultCancelled = function() {
    if (this._yieldedPromise instanceof Promise) {
        var promise = this._yieldedPromise;
        this._yieldedPromise = null;
        promise.cancel();
    }
};

PromiseSpawn.prototype.promise = function () {
    return this._promise;
};

PromiseSpawn.prototype._run = function () {
    this._generator = this._generatorFunction.call(this._receiver);
    this._receiver =
        this._generatorFunction = undefined;
    this._promiseFulfilled(undefined);
};

PromiseSpawn.prototype._continue = function (result) {
    ASSERT(this._yieldedPromise == null);
    var promise = this._promise;
    if (result === errorObj) {
        var defers = this._runDefers();
        if (defers === null) {
            this._cleanup();
            return this._cancellationPhase ?
                promise.cancel() :
                promise._rejectCallback(result.e, false);
        } else {
            var self = this;
            defers.done(function() {
                self._cleanup();
                return self._cancellationPhase ?
                    promise.cancel() :
                    promise._rejectCallback(result.e, false);
            });
            return;
        }
    }

    var value = result.value;
    if (result.done === true) {
        var defers = this._runDefers();
        if (defers === null) {
            this._cleanup();
            return this._cancellationPhase ?
                promise.cancel() :
                promise._resolveCallback(value);
        } else {
            var self = this;
            defers.done(function() {
                self._cleanup();
                return self._cancellationPhase ?
                    promise.cancel() :
                    promise._resolveCallback(value);
            });
            return;
        }
    } else {
        var maybePromise = tryConvertToPromise(value, this._promise);
        if (!(maybePromise instanceof Promise)) {
            maybePromise =
                promiseFromYieldHandler(maybePromise,
                                        this._yieldHandlers,
                                        this._promise);
            ASSERT(maybePromise === null || maybePromise instanceof Promise);
            if (maybePromise === null) {
                this._promiseRejected(
                    new TypeError(
                        YIELDED_NON_PROMISE_ERROR.replace("%s", value) +
                        FROM_COROUTINE_CREATED_AT +
                        this._stack.split("\n").slice(1, -7).join("\n")
                    )
                );
                return;
            }
        }
        maybePromise = maybePromise._target();
        var bitField = maybePromise._bitField;
        USE(bitField);
        if (BIT_FIELD_CHECK(IS_PENDING_AND_WAITING_NEG)) {
            this._yieldedPromise = maybePromise;
            maybePromise._proxy(this, null);
        } else if (BIT_FIELD_CHECK(IS_FULFILLED)) {
            this._promiseFulfilled(maybePromise._value());
        } else if (BIT_FIELD_CHECK(IS_REJECTED)) {
            this._promiseRejected(maybePromise._reason());
        } else {
            this._promiseCancelled();
        }
    }
};

PromiseSpawn.prototype._defer = function(fn) {
    this._defers.push(fn);
};

PromiseSpawn.prototype._runDefers = function() {
    if (this._defers.length === 0) {
        return null;
    }
    for (var p = Promise.resolve(), k = this._defers.length - 1; k >= 0; --k) {
        p = p.then(this._defers[k]);
    }
    p = p.caught(util.panic);
    return p;
};

Promise.coroutine = function (generatorFunction, options) {
    //Throw synchronously because Promise.coroutine is semantically
    //something you call at "compile time" to annotate static functions
    if (typeof generatorFunction !== "function") {
        throw new TypeError(NOT_GENERATOR_ERROR);
    }
    var yieldHandler = Object(options).yieldHandler;
    var PromiseSpawn$ = PromiseSpawn;
    var stack = new Error().stack;
    return function () {
        var generator = generatorFunction.apply(this, arguments);
        var spawn = new PromiseSpawn$(undefined, undefined, yieldHandler,
                                      stack);
        var ret = spawn.promise();
        spawn._generator = generator;
        spawn._promiseFulfilled(undefined);
        return ret;
    };
};

Promise.coroutine.defer = function(fn) {
    if (typeof fn != "function") {
        throw new TypeError(FUNCTION_ERROR + util.classString(fn));
    }
    if (coroutines.currentCoroutine == null) {
        throw new RangeError("co.defer can only be used within a coroutine");
    }
    coroutines.currentCoroutine._defer(fn);
};

Promise.coroutine.addYieldHandler = function(fn) {
    if (typeof fn !== "function") {
        throw new TypeError(FUNCTION_ERROR + util.classString(fn));
    }
    yieldHandlers.push(fn);
};

Promise.spawn = function (generatorFunction) {
    debug.deprecated("Promise.spawn()", "Promise.coroutine()");
    //Return rejected promise because Promise.spawn is semantically
    //something that will be called at runtime with possibly dynamic values
    if (typeof generatorFunction !== "function") {
        return apiRejection(NOT_GENERATOR_ERROR);
    }
    var spawn = new PromiseSpawn(generatorFunction, this);
    var ret = spawn.promise();
    spawn._run(Promise.spawn);
    return ret;
};
};
