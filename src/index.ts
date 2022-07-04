"use strict";
let hoxy = require('hoxy');
const fs = require('fs');

const { StringDecoder } = require('string_decoder');
const decoder = new StringDecoder('utf8');

type ProxyType = "direct" | "reverse";
type ProxyStatus = "initialized" | "listening" | "shutdown";

class HttpProxy {
  private onResponseHooks : [];
  private status : ProxyStatus;

  constructor(private destinationUrl: string, private port:number, private proxyType: ProxyType, private name: String) {

    const uniqueID = new Date().getTime().toString();
    this.name = name ? name + " " + uniqueID : uniqueID;
    this.log = logger(`Proxy | ${this.name}`);

    this.onResponseHooks = [];
    this.status = "initialized";
  }

  getRestfulEndpointUrlForDMASettings() {
    if (this.proxyType === DIRECT_PROXY) {
      return this.destinationUrl;
    } else {
      return `http://${this.ipForReverseProxyType}:${this.port}`;
    }
  }

  getProxyType() {
    return this.proxyType;
  }

  addOnResponseHook(hook) {
    this.onResponseHooks.push(hook);
  }

  clearHooks() {
    this.log.info('clear all hooks');
    this.onResponseHooks = [];
    this.requestCallback = null;
    this.requestHeaderModifyCallback = null;
    this.requestBodyModifyCallback = null;
  }


  onRequest(callback) {
    this.requestCallback = callback;
  }

  onRequestHeaderModify(callback){
    this.requestHeaderModifyCallback = callback;
  }
  
  onRequestBodyModify(callback) {
    this.requestBodyModifyCallback = callback;
  }

  /*
    URL: /api/users/app-config 
    request: {
        ...
    }
    response: {
        "maintenanceRoutines": [
            {
            "featureName": "bill_payment",
            "startTime": 61200000,
            "endTime": 61260000
            },
            {
            "featureName": "top_up_payment",
            "startTime": 61200000,
            "endTime": 61260000
            },
            ...
        ],
        ...
    }

    In the above sample HTTP request/response pair, if we want to modify the "startTime" for array element with "featureName" as
    "top_up_payment" to "123456", then the following args should be provided.
        - requestUrl = "/api/users/app-config"
        - arrayPath = "maintenanceRoutines"
        - arrayElementLocatorKey = "featureName"
        - arrayElementLocatorValue = "top_up_payment"
        - elementPropertyToBeUpdated = "startTime"
        - value = "123456"
  */
  modifyArrayElementInResponse(requestUrl, arrayPath, arrayElementLocatorKey, arrayElementLocatorValue, elementPropertyToBeUpdated, value) {
    this.addOnResponseHook((req, resp) => {
      if (req.url === requestUrl) {
        if (!resp.json[arrayPath]) {
          return;
        }

        const index = resp.json[arrayPath].findIndex(entry => {
          return entry[arrayElementLocatorKey] === arrayElementLocatorValue;
        });

        if (index >= 0) {
          resp.json[arrayPath][index][elementPropertyToBeUpdated] = value;
        }
      }
    });
  }

  /*
    URL: /api/users/app-config 
    request: {
        ...
    }
    response: {
        "maintenanceRoutines": [
            {
            "featureName": "bill_payment",
            "startTime": 61200000,
            "endTime": 61260000
            },
            {
            "featureName": "fcd_own_account_transfer",
            "startTime": 61200000,
            "endTime": 61260000
            "days": [
                      {
                        "name": "saturday",
                        "startTime": 61200000,
                        "endTime": 147600000,
                        "isAllDay": true
                      },
                      {
                        "name": "sunday",
                        "startTime": 61200000,
                        "endTime": 147600000,
                        "isAllDay": true
                      }
                    ]
              },
            ...
        ],
        ...
    }
    In the above sample HTTP request/response pair, if we want to modify the "name" of array element "days" of "featureName" of
    "fcd_own_account_transfer" to "monday", then the following args should be provided.
        - requestUrl = "/api/users/app-config"
        - arrayPath = "maintenanceRoutines"
        - arrayElementLocatorKey = "featureName"
        - arrayElementLocatorValue = "fcd_own_account_transfer"
        - elementPropertyToBeUpdated = "days"
        - value = "name"
        - elementValue = "monday"
  */
  modifyElementValueInResponse(requestUrl, arrayPath, arrayElementLocatorKey, arrayElementLocatorValue, elementPropertyToBeUpdated, value, elementValue) {
  this.addOnResponseHook((req, resp) => {
    if (req.url === requestUrl) {
      if (!resp.json[arrayPath]) {
        return;
      }
      const index = resp.json[arrayPath].findIndex(entry => {
        return entry[arrayElementLocatorKey] === arrayElementLocatorValue;
      });
      if (index >= 0) {
        resp.json[arrayPath][index][elementPropertyToBeUpdated][0][value] = elementValue;
      }
    }
  });
}

  modifyFieldInResponse(requestUrl, fieldToBeUpdated, value) {
    this.addOnResponseHook((req, resp) => {
      if (req.url === requestUrl) {
        resp.json[fieldToBeUpdated] = value;
      }
    });
  }

  modifyResponseStatusCode(requestUrl, statusCode) {
    this.addOnResponseHook((req, resp) => {
      if (req.url === requestUrl) {    
        resp.statusCode = statusCode;
      }
    });
  }
  

  start() {
    this.log.info(`starting ${this.proxyType} proxy on http://${this.ipForReverseProxyType}:${this.port} for ${this.destinationUrl}`);
    const opts = (this.proxyType === DIRECT_PROXY) ?
      {
        certAuthority: {
          key: fs.readFileSync(__dirname + '/agent2-key.pem'),
          cert: fs.readFileSync(__dirname + '/agent2-cert.pem')
        }
      } :
      {
        reverse: this.destinationUrl,
      }

    try {
      const proxy = hoxy.createServer(opts);

      proxy.log('error warn info debug');

      proxy.intercept({
        phase: 'request',
        as: 'buffer'
      }, (req, resp, cycle) => {
        this.log.info(`[${this.description()}] request sent for ${req.url}`);
        this.requestCallback && this.requestCallback(req, resp);
        this.requestHeaderModifyCallback && this.requestHeaderModifyCallback(req,resp);
        if(req.buffer) {
          let body = decoder.write(Buffer.from(req.buffer));
          if(body) {
            req.json = JSON.parse(body);
          }
          this.requestBodyModifyCallback && this.requestBodyModifyCallback(req, resp);
        }
      });

      proxy.intercept({
        phase: 'response',
        as: 'buffer'
        }, (req, resp, cycle) => {
          this.log.info(`[${this.description()}] response get for ${req.url}`);

        if (resp.buffer) {
          let body = decoder.write(Buffer.from(resp.buffer));
          resp.rawBody = body;
          if (body) {
            try {
              resp.json = JSON.parse(body);
            } catch (err) {
              this.log.warn(`=========non-JSON body for ${req.url}: `, body);
            }
          }
        }
        
        for (const hook of this.onResponseHooks) {
          hook(req, resp);
          }
        });

      proxy.listen(this.port, err => {
        if (err) {
          throw new Error(err);
        }

        this.log.info(`listening on port ${this.port}...`);
      });

      this.status = "started";
    } catch (err) {
      this.log.error("[proxy] error", err);
    }
  }

  shutdown() {
    this.log.info(`shutting down the proxy...`);
  }

  description() {
    return `[${this.name} | ${this.proxyType} proxy on http://localhost:${this.port} for ${this.destinationUrl}]`
  }
}

function getDummyProxy() {
  return new Proxy({}, {
    get: function (target, property) {
      return function () {};
    }
  });
}

function newProxy(destinationUrl, port, proxyType = REVERSE_PROXY, proxyName) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return new HttpProxy(destinationUrl, port, proxyType, proxyName);
}


module.exports = {
  getDummyProxy,
  newProxy,
};

 