'use strict';

var _ = require('lodash');
var diameterCodec = require('./diameter-codec');
var diameterUtil = require('./diameter-util');
var Q = require('bluebird');


var DIAMETER_MESSAGE_HEADER_LENGTH_IN_BYTES = 20;

var getSessionId = function(message) {
    var sessionIdAvp = _.find(message.body, function(avp) {
        return avp[0] === 'Session-Id';
    });
    if (sessionIdAvp !== undefined) return sessionIdAvp[1];
    return undefined;
};

function DiameterConnection(options, socket) {
    if (!(this instanceof DiameterConnection)) {
        return new DiameterConnection(options, socket);
    }
    options = options || {};
    var self = this;
    self.socket = socket;
    self.options = options;
    self.pendingRequests = {};
    self.hopByHopIdCounter = diameterUtil.random32BitNumber();

    var buffer = new Buffer(0);

    self.socket.on('data', function(data) {
        try {
            buffer = Buffer.concat([buffer, data instanceof Buffer ? data : new Buffer(data)]);

            while (buffer.length >= DIAMETER_MESSAGE_HEADER_LENGTH_IN_BYTES) {
                var messageLength = diameterCodec.decodeMessageHeader(buffer).header.length;
                
                // If we collected the entire message
                if (buffer.length >= messageLength) {
                    var message = diameterCodec.decodeMessage(buffer);

                    if (message.header.flags.request) {
                        var response = diameterCodec.constructResponse(message);

                        if (_.isFunction(self.options.beforeAnyMessage)) {
                            self.options.beforeAnyMessage(message);
                        }

                        self.socket.emit('diameterMessage', {
                            sessionId: getSessionId(message),
                            message: message,
                            response: response,
                            callback: function(response) {
                                if (_.isFunction(self.options.afterAnyMessage)) {
                                    self.options.afterAnyMessage(response);
                                }
                                var responseBuffer = diameterCodec.encodeMessage(response);
                                setImmediate(function() {
                                    self.socket.write(responseBuffer);
                                });
                            }
                        });
                    } else {
                        console.log(`*****`)
                        console.log(`${JSON.stringify(message)}`);
                        var pendingRequest = self.pendingRequests[message.header.hopByHopId];
                        console.log(`pendingRequest: ${JSON.stringify(pendingRequest)}`);
                        if (pendingRequest != null) {
                            if (_.isFunction(self.options.afterAnyMessage)) {
                                self.options.afterAnyMessage(message);
                                console.log(`formated response got printed`);
                            }
                            delete self.pendingRequests[message.header.hopByHopId];
                            pendingRequest.deferred.resolve(message);
                        } else {
                            // handle this
                            console.log(`#####`)
                            for (const hopByHopId in self.pendingRequests) {
                                if (self.pendingRequests.hasOwnProperty(hopByHopId)) {
                                    console.log(`Checking pending request with hopByHopId: ${hopByHopId}`);
                            
                                    const request = self.pendingRequests[hopByHopId].request;
                                    console.log(`Request body:`, request.body);
                            
                                    // Search for the Session-Id in the incoming message body
                                    const messageSessionIdEntry = message.body.find(([key]) => key === "Session-Id");
                                    console.log(`Session-Id in incoming message body:`, messageSessionIdEntry);
                            
                                    if (messageSessionIdEntry) {
                                        const messageSessionId = messageSessionIdEntry[1]; // Extract the value of Session-Id
                                        console.log(`Extracted Session-Id from incoming message: ${messageSessionId}`);
                            
                                        // Search for the Session-Id in the request body
                                        const sessionIdEntry = request.body.find(([key, value]) => key === "Session-Id" && value === messageSessionId);
                                        console.log(`Session-Id in pending request body:`, sessionIdEntry);
                            
                                        if (sessionIdEntry) {
                                            console.log(`Matching Session-Id found: ${messageSessionId}`);
                                            console.log(`Resolving pending request for hopByHopId: ${hopByHopId}`);
                            
                                            const pendingRequest = self.pendingRequests[hopByHopId];
                                            
                                            // Delete the matched request
                                            if (_.isFunction(self.options.afterAnyMessage)) {
                                                self.options.afterAnyMessage(message);
                                                console.log(`formated response got printed`);
                                            }
                                            delete self.pendingRequests[hopByHopId];
                                            console.log(`Deleted pending request with hopByHopId: ${hopByHopId}`);
                            
                                            // Resolve the deferred promise
                                            pendingRequest.deferred.resolve(message);
                                            break; // Exit the loop after handling the matched request
                                        } else {
                                            console.log(`No matching Session-Id found in request body for hopByHopId: ${hopByHopId}`);
                                        }
                                    } else {
                                        console.log(`No Session-Id found in incoming message body.`);
                                    }
                                }
                            }   
                        }
                    }
                    buffer = buffer.slice(messageLength);
                } else {
                    // Header has been collected in the buffer, but not the entire message.
                    // So, end this event handler, and wait for another data event, with the
                    // rest of the message. 
                    return;
                }
            }
        } catch (err) {
            self.socket.emit('error', err);
        }
    });

    self.createRequest = function(application, command, sessionId) {
        if (sessionId === undefined) {
            sessionId = diameterUtil.random32BitNumber();
        }
        return diameterCodec.constructRequest(application, command, sessionId);
    };

    self.sendRequest = function(request, timeout) {
        var deferred = Q.defer();
        if (this.socket === undefined) {
            deferred.reject('Socket not bound to session.');
            return deferred.promise;
        }
        console.log(`Socket was bounded to session.`);
        timeout = timeout || this.options.timeout || 3000;
        request.header.hopByHopId = this.hopByHopIdCounter++;
        if (_.isFunction(this.options.beforeAnyMessage)) {
            console.log(`before request our request got printed`);
            this.options.beforeAnyMessage(request);
        }
        var requestBuffer = diameterCodec.encodeMessage(request);
        this.socket.write(requestBuffer);
        console.log(`requested message buffer : ${JSON.stringify(requestBuffer)}`);
        var promise = deferred.promise.timeout(timeout, 'Request timed out, no response was received in ' + timeout + 'ms');
        this.pendingRequests[request.header.hopByHopId] = {
            'request': request,
            'deferred': deferred
        };
        console.log(`pending requests : ${JSON.stringify(this.pendingRequests)}`);
        console.log(`the promise returned by sendRequest : ${JSON.stringify(promise)}`);
        return promise;
    };

    self.end = function() {
        socket.end();
    };
}

exports.DiameterConnection = DiameterConnection;
