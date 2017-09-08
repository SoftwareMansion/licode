/*global require*/
'use strict';
const Getopt = require('node-getopt');
const _ = require('lodash');

const os = require('os');
const spawn = require('child_process').spawn;

const config = require('config');
const db = require('./database').db;

const graphite = require('./common/graphite');

// Configuration default values
GLOBAL.config =  {};
GLOBAL.config.erizoAgent = config.get('erizoAgent');

const BINDED_INTERFACE_NAME = GLOBAL.config.erizoAgent.networkInterface;

// Parse command line arguments
const getopt = new Getopt([
  ['r' , 'rabbit-host=ARG'            , 'RabbitMQ Host'],
  ['g' , 'rabbit-port=ARG'            , 'RabbitMQ Port'],
  ['b' , 'rabbit-heartbeat=ARG'       , 'RabbitMQ AMQP Heartbeat Timeout'],
  ['l' , 'logging-config-file=ARG'    , 'Logging Config File'],
  ['M' , 'max-processes=ARG'           , 'Stun Server URL'],
  ['P' , 'prerun-processes=ARG'        , 'Default video Bandwidth'],
  ['I' , 'individual-logs'             , 'Use individual log files for ErizoJS processes'],
  ['m' , 'metadata=ARG'               , 'JSON metadata'],
  ['h' , 'help'                       , 'display this help']
]);

var interfaces = os.networkInterfaces(),
    addresses = [],
    k,
    k2,
    address,
    privateIP,
    publicIP;

var opt = getopt.parse(process.argv.slice(2));

var metadata;

for (var prop in opt.options) {
    if (opt.options.hasOwnProperty(prop)) {
        var value = opt.options[prop];
        switch (prop) {
            case 'help':
                getopt.showHelp();
                process.exit(0);
                break;
            case 'rabbit-host':
                GLOBAL.config.rabbit = GLOBAL.config.rabbit || {};
                GLOBAL.config.rabbit.host = value;
                break;
            case 'rabbit-port':
                GLOBAL.config.rabbit = GLOBAL.config.rabbit || {};
                GLOBAL.config.rabbit.port = value;
                break;
            case 'rabbit-heartbeat':
                GLOBAL.config.rabbit = GLOBAL.config.rabbit || {};
                GLOBAL.config.rabbit.heartbeat = value;
                break;
            case 'max-processes':
                GLOBAL.config.erizoAgent = GLOBAL.config.erizoAgent || {};
                GLOBAL.config.erizoAgent.maxProcesses = value;
                break;
            case 'prerun-processes':
                GLOBAL.config.erizoAgent = GLOBAL.config.erizoAgent || {};
                GLOBAL.config.erizoAgent.prerunProcesses = value;
                break;
            case 'individual-logs':
                GLOBAL.config.erizoAgent = GLOBAL.config.erizoAgent || {};
                GLOBAL.config.erizoAgent.useIndividualLogFiles = true;

                break;
            case 'metadata':
                metadata = JSON.parse(value);
                break;
            default:
                GLOBAL.config.erizoAgent[prop] = value;
                break;
        }
    }
}

// Load submodules with updated config
var logger = require('./common/logger').logger;
var amqper = require('./common/amqper');

// Logger
var log = logger.getLogger('ErizoAgent');

var idleErizos = [];

var erizos = [];

var processes = {};

var guid = (function() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
               .toString(16)
               .substring(1);
  }
  return function() {
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
           s4() + '-' + s4() + s4() + s4();
  };
})();

var myErizoAgentId = guid();

var launchErizoJS;

var fillErizos = function () {
    if (erizos.length + idleErizos.length < GLOBAL.config.erizoAgent.maxProcesses) {
        if (idleErizos.length < GLOBAL.config.erizoAgent.prerunProcesses) {
            launchErizoJS();
            fillErizos();
        }
    }
};

const reportMetrics = function () {
    const now = Date.now();
    const interval = global.config.erizoAgent.statsUpdateInterval * 2;

    db.erizoJS.aggregate(
        [
            {
                $match: {
                    erizoAgentID: myErizoAgentId,
                    lastUpdated: { $lte: new Date(now), $gte: new Date(now - interval) }
                }
            },
            { $sort: { lastUpdated: -1 } },
            {
                $group: {
                    _id: { erizoAgentID: '$erizoAgentID', erizoJSID: '$erizoJSID' },
                    publishersCount: { $first: '$publishersCount' },
                    subscribersCount: { $first: '$subscribersCount' },
                    stats: { $first: '$stats' }
                }
            },
            {
                $group: {
                    _id: '$_id.erizoAgentID',

                    publishersCount: { $sum: '$publishersCount' },
                    subscribersCount: { $sum: '$subscribersCount' },

                    video_fractionLost_min: { $min: '$stats.video.fractionLost.min' },
                    video_fractionLost_max: { $max: '$stats.video.fractionLost.max' },
                    video_fractionLost_total: { $sum: '$stats.video.fractionLost.total' },
                    video_fractionLost_count: { $sum: '$stats.video.fractionLost.count' },

                    video_jitter_min: { $min: '$stats.video.jitter.min' },
                    video_jitter_max: { $max: '$stats.video.jitter.max' },
                    video_jitter_total: { $sum: '$stats.video.jitter.total' },
                    video_jitter_count: { $sum: '$stats.video.jitter.count' }
                }
            }
        ],
        (err, docs) => {
            if (err) {
                log.warn('failed to collect erizoAgent metrics', err);
                return;
            }

            if (docs.length === 0) {
                return;
            }

            if (docs.length !== 1) {
                log.error(`expected single document result, got ${JSON.stringify(docs, null, 2)}`);
                return;
            }

            const d = docs[0];

            graphite.put('publishers.count', d.publishersCount);
            graphite.put('subscribers.count', d.subscribersCount);

            graphite.put('video.fractionLost.min', d.video_fractionLost_min);
            graphite.put('video.fractionLost.max', d.video_fractionLost_max);
            graphite.put('video.fractionLost.avg', d.video_fractionLost_total / d.video_fractionLost_count);

            graphite.put('video.jitter.min', d.video_jitter_min);
            graphite.put('video.jitter.max', d.video_jitter_max);
            graphite.put('video.jitter.avg', d.video_jitter_total / d.video_jitter_count);

            log.debug('submitted erizoAgent metrics');
        }
    );
};

setInterval(reportMetrics, config.erizoAgent.statsUpdateInterval);

launchErizoJS = function() {
    var id = guid();
    log.debug('message: launching ErizoJS, erizoId: ' + id);
    var fs = require('fs');
    var erizoProcess, out, err;
    if (GLOBAL.config.erizoAgent.useIndividualLogFiles){
        out = fs.openSync(GLOBAL.config.erizoAgent.instanceLogDir + '/erizo-' + id + '.log', 'a');
        err = fs.openSync(GLOBAL.config.erizoAgent.instanceLogDir + '/erizo-' + id + '.log', 'a');
        erizoProcess = spawn('./launch.sh', ['erizoJS.js', myErizoAgentId, id, privateIP, publicIP],
                             { detached: true, stdio: [ 'ignore', out, err ] });
    }else{
        erizoProcess = spawn('./launch.sh', ['erizoJS.js', myErizoAgentId, id, privateIP, publicIP],
                            { detached: true, stdio: [ 'ignore', 'pipe', 'pipe' ] });
        erizoProcess.stdout.setEncoding('utf8');
        erizoProcess.stdout.on('data', function (message) {
            console.log('[erizo-' + id + ']',message.replace (/\n$/,''));
        });
        erizoProcess.stderr.setEncoding('utf8');
        erizoProcess.stderr.on('data', function (message) {
            console.log('[erizo-' + id + ']',message.replace (/\n$/,''));
        });
    }
    erizoProcess.unref();
    erizoProcess.on('close', function () {
        log.info('message: closed, erizoId: ' + id);
        var index = idleErizos.indexOf(id);
        var index2 = erizos.indexOf(id);
        if (index > -1) {
            idleErizos.splice(index, 1);
        } else if (index2 > -1) {
            erizos.splice(index2, 1);
        }

        if (out !== undefined){
            fs.close(out, function (message){
                if (message){
                    log.error('message: error closing log file, ' +
                              'erizoId: ' + id + ', error:', message);
                }
            });
        }

        if(err !== undefined){
            fs.close(err, function (message){
                if (message){
                    log.error('message: error closing log file, ' +
                              'erizoId: ' + id + ', error:', message);
                }
            });
        }
        delete processes[id];
        fillErizos();
    });

    log.info('message: launched new ErizoJS, erizoId: ' + id);
    processes[id] = erizoProcess;
    idleErizos.push(id);
};

var dropErizoJS = function(erizoId, callback) {
   if (processes.hasOwnProperty(erizoId)) {
      log.warn('message: Dropping Erizo that was not closed before - ' +
               'possible publisher/subscriber mismatch, erizoId:' + erizoId);
      var process = processes[erizoId];
      process.kill();
      delete processes[erizoId];

      db.erizoJS
        .remove({
            erizoAgentID: myErizoAgentId,
            erizoJSID: erizoId,
        }, function (error) {
            if (error) {
                log.warn('message: remove erizoJS error, ' + logger.objectToLog(error));
            }
            callback('callback', 'ok');
        });
   }
};

var cleanErizos = function () {
    log.debug('message: killing erizoJSs on close, numProcesses: ' + processes.length);
    for (var p in processes){
        log.debug('message: killing process, processId: ' + processes[p].pid);
        processes[p].kill('SIGKILL');
    }
    process.exit(0);
};

var getErizo = function () {

    var erizoId = idleErizos.shift();

    if (!erizoId) {
        if (erizos.length < GLOBAL.config.erizoAgent.maxProcesses) {
            launchErizoJS();
            return getErizo();
        } else {
            erizoId = erizos.shift();
        }
    }

    return erizoId;
};

// TODO: get metadata from a file
var reporter = require('./erizoAgentReporter').Reporter({id: myErizoAgentId, metadata: metadata});

var api = {
    createErizoJS: function(callback) {
        try {

            var erizoId = getErizo();
            log.debug('message: createErizoJS returning, erizoId: ' + erizoId);
            callback('callback', {erizoId: erizoId, agentId: myErizoAgentId});

            erizos.push(erizoId);
            fillErizos();

        } catch (error) {
            log.error('message: error creating ErizoJS, error:', error);
        }
    },
    deleteErizoJS: function(id, callback) {
        try {
            dropErizoJS(id, callback);
        } catch(err) {
            log.error('message: error stopping ErizoJS');
        }
    },
    getErizoAgents: reporter.getErizoAgent
};

for (k in interfaces) {
    if (interfaces.hasOwnProperty(k)) {
      if (!GLOBAL.config.erizoAgent.networkinterface ||
          GLOBAL.config.erizoAgent.networkinterface === k) {
        for (k2 in interfaces[k]) {
            if (interfaces[k].hasOwnProperty(k2)) {
                address = interfaces[k][k2];
                if (address.family === 'IPv4' && !address.internal) {
                    if (k === BINDED_INTERFACE_NAME || !BINDED_INTERFACE_NAME) {
                        addresses.push(address.address);
                    }
                }
            }
        }
      }
    }
}

privateIP = addresses[0];

if (GLOBAL.config.erizoAgent.publicIP === '' || GLOBAL.config.erizoAgent.publicIP === undefined) {
    publicIP = addresses[0];

    if (config.get('cloudProvider.name') === 'amazon') {
        var AWS = require('aws-sdk');
        new AWS.MetadataService({
            httpOptions: {
                timeout: 5000
            }
        }).request('/latest/meta-data/public-ipv4', function(err, data) {
            if (err) {
                log.info('Error: ', err);
            } else {
                log.info('Got public ip: ', data);
                publicIP = data;
                fillErizos();
            }
        });
    } else {
        fillErizos();
    }
} else {
    publicIP = GLOBAL.config.erizoAgent.publicIP;
    fillErizos();
}

// Will clean all erizoJS on those signals
process.on('SIGINT', cleanErizos);
process.on('SIGTERM', cleanErizos);

amqper.connect(function () {
    amqper.setPublicRPC(api);
    amqper.bind('ErizoAgent');
    amqper.bind('ErizoAgent_' + myErizoAgentId);
    amqper.bindBroadcast('ErizoAgent', function () {
        log.warn('message: amqp no method defined');
    });
});
