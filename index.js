'use strict';
var curl = require('request'),
  url = require('url'),
  async = require('async'),
  crypto = require('crypto'),
  redis = require('redis'),
  MobileAgent = require('mobile-agent');

/**
 * @module express-view-cache
 */


/**
 * @class EVC
 * @classdesc
 * This class accepts redis connection parameters as constructor, and builds Caching Middleware
 * by method { link EVC#cachingMiddleware }
 * @see EVC#cachingMiddleware
 */


function EVC(options, dbIndex) {
  var config = {},
    redisClient,
    o,
    cacheKey = crypto.createHash('md5').update('I_WANNA_TEA_AND_MEAT' + (Math.random() * Date.now())).digest('hex').toString();

  if (typeof options === 'string') {
    o = url.parse(options);
    if (o.protocol === 'redis:') {
      config.host = o.hostname || 'localhost';
      config.port = o.port || 6379;
      config.pass = o.auth ? o.auth[1] : null;
      config.appPort = process.env.PORT || 3000;
      config.dbIndex = dbIndex;
    } else {
      throw new Error('ExpressViewCache - unable to parse ' + o + ' as redis connection string!');
    }
  } else {
    config = {
      'host': options.host || 'localhost',
      'port': options.port || 6379,
      'pass': options.pass,
      'client': options.client,
      'appPort': options.appPort || process.env.PORT || 3000,
      'dbIndex': dbIndex
    };
  }

  redisClient = config.client || redis.createClient(config.port, config.host, {
    'auth_pass': config.pass,
    'return_buffers': true,
    'db': config.dbIndex
  });

/**
* detect if bot
*/
function isBot(ua){
    var knownBots = /bot|index|spider|crawl|wget|slurp|python|nagios|baiduspider|facebookexternalhit|twitterbot|rogerbot|linkedinbot|embedly|quora|pinterest|slackbot|W3C_Validator/i;
    return knownBots.test(ua);
}

  /**
   * @method EVC#cachingMiddleware
   * @param {Number} [ttlInMilliSeconds=30000]
   * @param {Array} queryParams cache based on query parameter
   * @param {Boolean} [isResponsive=true]
   * @return {function} function(req, res, next){...}
   */

  this.cachingMiddleware = function (ttlInMilliSeconds,queryParams,followRedirection, isResponsive, ignoreBot) {
    ttlInMilliSeconds = parseInt(ttlInMilliSeconds, 10) || 30000;
    isResponsive = typeof isResponsive === "undefined" ? false : isResponsive;

    return function (req, res, next) {
      if(ignoreBot && isBot(req && req.headers['user-agent'])) return false;
      if (req.method === 'GET' && req.headers.express_view_cache !== cacheKey) {
        var urlToUse = req.originalUrl;

        var responsiveSuffix = '';
          // get device type (mobile/desktop)
        if (!isResponsive) {
            responsiveSuffix = isMobile(req) ? ':mobile' : ':desktop';
        }

        var query = req.query;
        if(queryParams) {
          if(queryParams.length===0){
            urlToUse=req.originalUrl.split("?")[0];
          } else {
            var queryParamsFinal="";
            var count = 0;
            for(var i=0;i<queryParams.length;i++){
              if(query[queryParams[i]]){
                queryParamsFinal+=(count==0?"?":"&")+queryParams[i]+"="+query[queryParams[i]];
                count++;
              }
            }
            if(req.originalUrl.indexOf("?")){
              urlToUse=req.originalUrl.split("?")[0]+queryParamsFinal;
            } else {
              urlToUse=req.originalUrl+queryParamsFinal;
            }
          }
        }

        var key = urlToUse,
            responsiveKey = urlToUse + responsiveSuffix,
          data = {};
          console.log("key used in caching module================="+ key);
        async.waterfall([
          function (cb) {
            async.parallel({
              'dataFound': function (clb) {
                redisClient.hgetall(responsiveKey, clb);
              },
              'age': function (clb) {
                redisClient.ttl(responsiveKey, clb);
              }
            }, function (error, obj) {
              if (error) {
                cb(error);
              } else {
                cb(null, obj.dataFound, obj.age);
              }
            });
          },
          function (dataFound, age, cb) {
            if (dataFound) {
              console.log("key found in caching module================="+ responsiveKey);
              data.Expires = new Date(Date.now() + age).toUTCString();
              data['Last-Modified'] = new Date(dataFound.savedAt).toUTCString();
              data['Content-Type'] = dataFound.contentType;
              data.statusCode = dataFound.statusCode;
              data.content = dataFound.content;
              data.cookie = res._headers['set-cookie'];
              cb(null, true);
            } else {
              console.log("key not found in caching module================="+ responsiveKey);
              var headers = req.headers;
              var flagFollowRedirection = false;
              if(followRedirection){
                flagFollowRedirection = followRedirection;
              }
              headers.express_view_cache = cacheKey;
              curl({
                'method': 'GET',
                'headers': headers,
                'url': 'http://localhost:' + config.appPort + req.originalUrl,
                'followRedirect': flagFollowRedirection
              }, function (error, response, body) {
                if (error) {
                  cb(error);
                } else {
                  data.Expires = new Date(Date.now() + ttlInMilliSeconds).toUTCString();
                  data['Last-Modified'] = new Date().toUTCString();
                  data['Content-Type'] = response.headers['content-type'];
                  data.statusCode = response.statusCode;
                  data.content = body;
                  if(data.statusCode===301) {
                    data.redirectUrl = response.headers.location;
                  }

                  data['cookie'] = response.headers['set-cookie'];

                  cb(error, false);
                }
              });
            }
          },

          function (hit, cb) {
            if (hit) {
              res && res.setHeader('via-rcache', true);
              if(req && req.headers){
                req['headers']['via-rcache'] = true;
              }
              cb(null);
            } else {
              async.series([
                function (clb) {
                  if(data.statusCode == 200){
                    redisClient.hmset(responsiveKey, {
                      'savedAt': new Date(),
                      'contentType': data['Content-Type'],
                      'statusCode': data.statusCode,
                      'content': data.content
                    }, clb);
                  }else{
                    clb();
                  }
                },
                function (clb) {
                  redisClient.expire(responsiveKey, Math.floor(ttlInMilliSeconds / 1000), clb);
                }
              ], cb);
            }
          }
        ], function (error) {
          if (error) {
            next(error);
          } else {
            if(data.statusCode===301) {
                return res.redirect(301,data.redirectUrl);
              } else {
                if (data && data.cookie) {
                  res.setHeader('Set-Cookie', data.cookie);
                }
                res.set('Expires', data.Expires);
                res.set('Last-Modified', data['Last-Modified']);
                res.set('Content-Type', data['Content-Type']);
                res.status(data.statusCode);

                res.send(data.content);
            }
          }
        });
      } else {
        next();
      }
    };
  };
  return this;
}

/**
 * Returns boolean value for whether the client is using mobile/desktop browser
 * @param  {Object}  req
 * @return {Boolean} isMobile[true/false]
 */
function isMobile(req) {
    var agent = MobileAgent(req.headers["user-agent"]);
    return agent.Mobile;
}

module.exports = exports = function (config, dbIndex) {
  return new EVC(config, dbIndex);
};
