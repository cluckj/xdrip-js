const crypto = require('crypto');
const events = require('events');
const util = require('util');
const fs = require('fs');
const debug = require('debug')('transmitter');

const BluetoothManager = require('./bluetooth-manager');

// auth messages
const AuthRequestTxMessage = require('./messages/auth-request-tx-message');           // 0x01, 0x02
const AuthChallengeRxMessage = require('./messages/auth-challenge-rx-message');       // 0x03
const AuthChallengeTxMessage = require('./messages/auth-challenge-tx-message');       // 0x04
const AuthStatusRxMessage = require('./messages/auth-status-rx-message');             // 0x05
const KeepAliveTxMessage = require('./messages/keep-alive-tx-message');               // 0x06
const BondRequestTxMessage = require('./messages/bond-request-tx-message');           // 0x07
const BondRequestRxMessage = require('./messages/bond-request-rx-message');           // 0x08

// control messages
const UnbondRequestTxMessage = require('./messages/unbond-request-tx-message');       // 0x06
const DisconnectTxMessage = require('./messages/disconnect-tx-message');              // 0x09
// TODO: create BatteryStatusTxMessage                                                // 0x22
// TODO: create BatteryStatusRxMessage                                                // 0x23
const TransmitterTimeTxMessage = require('./messages/transmitter-time-tx-message');   // 0x24
const TransmitterTimeRxMessage = require('./messages/transmitter-time-rx-message');   // 0x25
const SessionStartTxMessage = require('./messages/session-start-tx-message');         // 0x26
const SessionStartRxMessage = require('./messages/session-start-rx-message');         // 0x27
// TODO: create SessionStopTxMessage                                                  // 0x28
// TODO: create SessionStopRxMessage                                                  // 0x29
const SensorTxMessage = require('./messages/sensor-tx-message');                      // 0x2e
const SensorRxMessage = require('./messages/sensor-rx-message');                      // 0x2f
const GlucoseTxMessage = require('./messages/glucose-tx-message');                    // 0x30
const GlucoseRxMessage = require('./messages/glucose-rx-message');                    // 0x31
const CalibrationDataTxMessage = require('./messages/calibration-data-tx-message');   // 0x32
const CalibrationDataRxMessage = require('./messages/calibration-data-rx-message');   // 0x33
const CalibrateGlucoseTxMessage = require('./messages/calibrate-glucose-tx-message'); // 0x34
const CalibrateGlucoseRxMessage = require('./messages/calibrate-glucose-rx-message'); // 0x35
const VersionRequestTxMessage = require('./messages/version-request-tx-message');     // 0x4a
const VersionRequestRxMessage = require('./messages/version-request-rx-message');     // 0x4b
const BackfillTxMessage = require('./messages/backfill-tx-message');                  // 0x50
const BackfillRxMessage = require('./messages/backfill-rx-message');                  // 0x51

const Glucose = require('./glucose');
const UUID = require('./bluetooth-services');

let manager;
let cryptKey;
let startPending = false;
let calibrationPending = null;

function Transmitter(id) {
  try {
    this.status = require('../status');
  } catch (err) {
    this.status = {
      id: id,
      version: null
    }
    persistStatus.call(this);
  }
  this.id = id;
  cryptKey = '00' + id + '00' + id;
  manager = new BluetoothManager(this);
}

util.inherits(Transmitter, events.EventEmitter);

Transmitter.prototype.shouldConnect = function(peripheral) {
  const name = peripheral.advertisement.localName;
  if (!name) return false;
  return lastTwoCharactersOfString(name) == lastTwoCharactersOfString(this.id);
};

Transmitter.prototype.isReady = function() {
  // TODO: control proceeds whether or not auth was successful. Fix.
  if (false) {
    listen.call(this);
  }
  else {
    debug('ready to go');
    authenticate.call(this)
    .then(control.bind(this))
//    control.call(this)
    .catch(debug);
  }
};

Transmitter.prototype.didDisconnect = function() {
  this.emit('disconnect');
};

Transmitter.prototype.startSensor = function() {
  console.log("in transmitter start sensor fn");
  startPending = true;
};

Transmitter.prototype.calibrate = function(glucose) {
  console.log("in transmitter calibrate fn");
  calibrationPending = glucose;
};

function authenticate() {
  console.log("startPending = " + startPending);

  const uuid = UUID.CGMServiceCharacteristic.Authentication;

  const message = new AuthRequestTxMessage();
  return manager.writeValueAndWait(message.data, uuid)
  .then(() => manager.readValueAndWait(uuid, AuthChallengeRxMessage.opcode))
  .then(data => {
    const response = new AuthChallengeRxMessage(data);
    if (response.tokenHash.equals(calculateHash(message.singleUseToken))) {
      return response;
    } else {
      throw 'transmitter failed auth challenge';
    }
  })
  // consider nesting these next two then() statements (i.e. write then read)
  .then(response => {
    const challengeHash = calculateHash(response.challenge);
    const message = new AuthChallengeTxMessage(challengeHash);
    return manager.writeValueAndWait(message.data, uuid);
  })
  .then(() =>
    manager.readValueAndWait(uuid, AuthStatusRxMessage.opcode)
    .catch(reason => {throw 'Error: ' + reason;})
  )
  .then(data => {
    const status = new AuthStatusRxMessage(data);
    debug('transmitter responded with status message ' + data.toString('hex'));
    if (status.authenticated !== 1) {
      throw 'transmitter rejected auth challenge';
    }
   const message = new KeepAliveTxMessage(25);
   return manager.writeValueAndWait(message.data, uuid)
   .then(() => {
      if (status.bonded === 1) {
        debug('transmitter already bonded');
        return;
      }
      const message = new BondRequestTxMessage();
      return manager.writeValueAndWait(message.data, uuid);
   });
  });
}

function control() {
  const uuid = UUID.CGMServiceCharacteristic.Control;

  // const message = new UnbondRequestTxMessage();
  // return manager.writeValueAndWait(message.data, uuid)
  //
  // .then(() => {
    return manager.setNotifyEnabledAndWait(true, uuid)
  // })
  // update tranmitter version, if necessary
  .then(() => {
    return processVersion.call(this, uuid);
  }).then(debug)
  // send tranmitter time tx message
  .then(() => {
    const message = new TransmitterTimeTxMessage();
    return manager.writeValueAndWaitForNotification(message.data, uuid);
  })
  .then(data => {
    const syncDate = Date.now();
    const timeMessage = new TransmitterTimeRxMessage(data);
    // deal with calibrations, if there are any
    return processCalibrations(uuid, timeMessage).then(debug)
    // deal with start/stop actions, if there are any
    .then(() => {
      return processStartStop(uuid, timeMessage);
    }).then(debug)
    // send glucose tx message
    .then(() => {
      const message = new GlucoseTxMessage();
      return manager.writeValueAndWaitForNotification(message.data, uuid);
    })
    // on receipt of glucose rx message create new glucose and notify observers
    .then(data => {
      const glucoseMessage = new GlucoseRxMessage(data);
      const message = new SensorTxMessage();
      return manager.writeValueAndWaitForNotification(message.data, uuid)
      .then((data) => {
        const message = new SensorRxMessage(data);
        const glucose = new Glucose(glucoseMessage, timeMessage, syncDate, sensorMessage = message);
        debug('got glucose of ' + glucose.glucose);
//        this.emit('glucose', glucose);
      });
    });
  })
  .then(() => manager.readValueAndWait(UUID.CGMServiceCharacteristic.Unknown))
  .then(() => manager.readValueAndWait(UUID.CGMServiceCharacteristic.Communication))
  .then(() => manager.setNotifyEnabledAndWait(false, uuid))
  .then(() => {
    const message = new DisconnectTxMessage();
    return manager.writeValueAndWait(message.data, uuid);
  })
  .then(processBackfill.bind(this)).then(debug)
  // TODO: after sending a glucose request 0x30, we should send a calibration data request (0x32)
  // TODO: have a think about what to do when an error occurs:
  // we want to catch it, and set notify to false regardless of the result
  // but prob return the rejected promise???
  .catch(debug);
}

function listen() {
  const uuid = UUID.CGMServiceCharacteristic.Control;
  characteristic = manager.getCharacteristicWithUUID(uuid);
  characteristic.once('data', data => {
    debug('Rx ' + data.toString('hex'));
  });
  return manager.setNotifyEnabledAndWait(true, uuid)
  .then(() => {
    return manager.wait(60000);
  });
}

function persistStatus() {
  console.log("in persistStatus");
  console.log(JSON.stringify(this.status));
  fs.writeFile('status.json', JSON.stringify(this.status), (err) => {
    if (err) {
        console.error(err);
        return;
    };
    console.log("File has been created");
  });
};


function processVersion(uuid) {
  if (!this.status.version) {
    const message = new VersionRequestTxMessage();
    return manager.writeValueAndWaitForNotification(message.data, uuid)
    .then(data => {
      debug('version: ' + data.toString('hex'))
      const reply = new VersionRequestRxMessage(data);
      this.status.version = reply.version;
      console.log("status: " + this.status);
      persistStatus.call(this);
    });
  } else {
    return Promise.resolve("Version info up to date, returning.");
  }
}

function processCalibrations(uuid, timeMessage) {
  if (calibrationPending) {
    const calibrationMessage = new CalibrateGlucoseTxMessage(calibrationPending, timeMessage.currentTime);
    return manager.writeValueAndWaitForNotification(calibrationMessage.data, uuid)
    .then(data => debug('calibrationRxMessage: ' + data.toString('hex')))
    .then(message => { // TODO: check here for success or otherwise
      calibrationPending = null;
    });
  } else {
    return Promise.resolve("No pending calibrations, returning.");
  }
}

function processStartStop(uuid, timeMessage) {
  if (startPending) { // TODO: test for pending stop actions
    const sessionStartMessage = new SessionStartTxMessage(timeMessage.currentTime - 60); // TODO: replace this time with the real time
    return manager.writeValueAndWaitForNotification(sessionStartMessage.data, uuid)
    .then(data => new SessionStartRxMessage(data))
    .then(message => { // TODO: check here for success or otherwise
      startPending = false;
    });
  } else {
    return Promise.resolve("No pending start/stop actions, returning.");
  }
}

function processBackfill() {
  if (true) { // TODO: test whether we need to ask for backfill
    return Promise.resolve("No need to backfill, returning.");
  } else {
    parser = new BackfillParser(/* callback */);
    const backfillMessage = new BackfillTxMessage();
    return manager.writeValueAndWaitForNotification(backfillMessage.data, uuid, BackfillRxMessage.opcode)
    .then(data => new BackfillRxMessage(data));
  }
}

function calculateHash(data) {
  if (data.length != 8) {
    throw Error('cannot hash');
  }

  const doubleData = Buffer.allocUnsafe(16);
  doubleData.fill(data, 0, 8);
  doubleData.fill(data, 8, 16);

  const encrypted = encrypt(doubleData);
  return Buffer.allocUnsafe(8).fill(encrypted);
}

function encrypt(buffer){
  const algorithm = 'aes-128-ecb';
  const cipher = crypto.createCipheriv(algorithm, cryptKey, '');
  const encrypted = Buffer.concat([cipher.update(buffer),cipher.final()]);
  return encrypted;
}

function lastTwoCharactersOfString(string) {
  return string.substr(string.length - 2);
}

module.exports = Transmitter;
