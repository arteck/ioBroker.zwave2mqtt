"use strict";

const core = require("@iobroker/adapter-core");
const mqtt = require("mqtt");
const utils = require("./lib/utils");
const constant = require("./lib/constants");

const adapterInfo = require("./lib/messages").adapterInfo;
const StatesController = require("./lib/statesController").StatesController;
const WebsocketController = require('./lib/websocketController').WebsocketController;
const Helper = require("./lib/helper").Helper;

const MqttServerController = require("./lib/mqttServerController").MqttServerController;

let mqttClient;
let deviceCache = {};
let nodeCache = {};
const logCustomizations = { debugDevices: "", logfilter: [] };

let websocketController;
let mqttServerController;
let statesController;
let helper;
let messageParseMutex = Promise.resolve();
let options = {};
let startListening = false;

let driver;
let controller;
let allNodes;
let eventTyp;


class zwave2mqtt extends core.Adapter {
  constructor(options) {
    super({
      ...options,
      name: "zwave2mqtt",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  async onReady() {
    statesController = new StatesController(this);

    // Initialize your adapter here
    adapterInfo(this.config, this.log);

    this.setState("info.connection", false, true);
    await statesController.setAllAvailableToFalse();

    helper = new Helper(this, deviceCache);

    const debugDevicesState = await this.getStateAsync("info.debugId");
    if (debugDevicesState && debugDevicesState.val) {
      logCustomizations.debugDevices = String(
        debugDevicesState.val.toLowerCase(),
      );
    }
    this.setState("info.debugmessages", "", true);

    // MQTT
    if (["exmqtt", "intmqtt"].includes(this.config.connectionType)) {
      // External MQTT-Server
      if (this.config.connectionType == "exmqtt") {
        if (this.config.externalMqttServerIP == "") {
          this.log.warn(
            "Please configure the External MQTT-Server connection!",
          );
          return;
        }

        // MQTT connection settings
        const mqttClientOptions = {
          clientId: `ioBroker.zwave2mqtt_${Math.random().toString(16).slice(2, 8)}`,
          clean: false,
          protocolVersion: 4,
          reconnectPeriod: 5000,
          connectTimeout: 30000,  // 30s
          keepalive: 30,
          resubscribe: true,
        };

        // Set external mqtt credentials
        if (this.config.externalMqttServerCredentials == true) {
          mqttClientOptions.username = this.config.externalMqttServerUsername;
          mqttClientOptions.password = this.config.externalMqttServerPassword;
        }

        // Init connection
        mqttClient = mqtt.connect(
          `mqtt://${this.config.externalMqttServerIP}:${this.config.externalMqttServerPort}`,
          mqttClientOptions,
        );
      } else {
        // Internal MQTT-Server
        mqttServerController = new MqttServerController(this);
        await mqttServerController.createMQTTServer();
        await this.delay(1500);
        mqttClient = mqtt.connect(
          `mqtt://${this.config.mqttServerIPBind}:${this.config.mqttServerPort}`,
          {
            clientId: `ioBroker.zwave2mqtt_${Math.random().toString(16).slice(2, 8)}`,
            clean: true,
            reconnectPeriod: 500,
          },
        );
      }

      // MQTT Client
      mqttClient.on("connect", () => {
        this.log.info(`Connect to zwave2MQTT over ${this.config.connectionType == "exmqtt" ? "external mqtt" : "internal mqtt"} connection.`);
        this.setState("info.connection", true, true);
      });

      mqttClient.subscribe(`${this.config.baseTopic}/#`);

      mqttClient.on("message", (topic, payload) => {
        const newMessage = `{"payload":${payload.toString() == "" ? '"null"' : payload.toString()},"topic":"${topic.slice(topic.search("/") + 1)}"}`;
        this.messageParse(newMessage);
      });
    }
    // Websocket
        else if (this.config.connectionType == 'ws') {
            if (this.config.wsServerIP == '') {
                this.log.warn('Please configure the Websoket connection!');
                return;
            }

            // Dummy MQTT-Server
            if (this.config.dummyMqtt == true) {
                mqttServerController = new MqttServerController(this);
                await mqttServerController.createDummyMQTTServer();
                this.setState("info.connection", true, true);
                await this.delay(1500);
            }

            this.startWebsocket();
        }
  }
  
  startWebsocket() {
      websocketController = new WebsocketController(this);
      const wsClient = websocketController.initWsClient();

      if (wsClient) {
          wsClient.on('open', () => {
              this.log.info('Connect to Zigbee2MQTT over websocket connection.');
              startListening = true;
              websocketController.send(JSON.stringify({command: "start_listening"}));
          });

          wsClient.on('message', (message) => {
              this.messageParse(message);
          });

          wsClient.on('close', async () => {
              this.setStateChanged('info.connection', false, true);
              await statesController.setAllAvailableToFalse();
              startListening = false;
              deviceCache = [];
              nodeCache = [];
              this.log.info('Websocket connection closed. Attempting to reconnect...');
          });
      }
  }
  
  async messageParse(message) {
    // Mutex lock: queue up calls to messageParse
    let release;
    const lock = new Promise((resolve) => (release = resolve));
    const prev = messageParseMutex;
    messageParseMutex = lock;
    await prev;

    try {
      const messageObj = JSON.parse(message);
      const type       = messageObj?.type;

      if (this.config.connectionType === 'ws') {
        switch (type) {
          case 'version':       // say hello
            this.setStateChanged('info.connection', true, true);
            this.setStateChanged('info.zwave_gateway_version', messageObj.driverVersion, true);
            this.setStateChanged('info.zwave_gateway_status', 'online', true);
            break;
          case 'result':
            if  (messageObj.result?.success === true) {
                this.setStateChanged('info.debugmessages', JSON.stringify(messageObj), true);
                break;
            }

            driver = messageObj.result.state.driver;
            controller = messageObj.result.state.controller;
            allNodes = messageObj.result.state.nodes;

            for (const nodeData of allNodes) {
              const nodeId = utils.formatNodeId(nodeData.nodeId);
              if (!nodeCache[nodeId]) {
                  if (this.config.showNodeInfoMessage) {
                     this.log.info(`Node Info Update for ${nodeId}`);
                  }
                  nodeCache[nodeId] = {nodeId: nodeId};
              }
              await helper.createNode(`${nodeId}`, nodeData, options);
            }

            if (startListening) {
              websocketController.send(JSON.stringify({command: "start_listening"}));
              startListening = false;
            }
            break;
          case 'event':
            eventTyp = messageObj.event;

            switch (eventTyp.event) {
              case 'value updated':
                const nodeArg = eventTyp.args;
                let nodeIdOriginal = eventTyp.nodeId;
                let nodeId = utils.formatNodeId(nodeIdOriginal)

                let parsePath = `${nodeId}.${nodeArg.commandClassName}.${nodeArg.propertyName
                                      .replace(/[^\p{L}\p{N}\s]/gu, "")
                                      .replace(/\s+/g, " ")
                                      .trim()}`;
                if (nodeArg?.propertyKeyName) {
                    parsePath = `${parsePath}.${nodeArg.propertyKeyName
                      .replace(/[^\p{L}\p{N}\s]/gu, "")
                      .replace(/\s+/g, " ")
                      .trim()}`;

                  if (constant.RGB.includes(nodeArg.propertyKeyName)) {
                    parsePath = utils.replaceLastDot(parsePath);
                  }
                }

                if (nodeArg.commandClass === 119) {    // sonderlocke für node naming
                     switch (nodeArg.property) {
                         case 'name':
                             await helper.updateDevice(nodeId, nodeArg);
                             parsePath = `${nodeId}.info.${nodeArg.property}`;
                             break;
                         case 'location':

                             break;
                         default:
                             parsePath = `${nodeId}.info.${nodeArg.property}`;
                             break;
                     }
                 }

                this.log.debug(`${parsePath} ->> ${nodeArg.newValue}`);

                await helper.parse(`${parsePath}`, nodeArg.newValue, options);

                break;
              case 'statistics updated':
              case 'metadata updated':
              case 'sleep':
              case 'wake up':
              case 'value added':
              case 'node info received':
                break;
              default:
                this.log.warn('New type event ->> ' + eventTyp.event);
                break;
            }

            break;
          default:
            break;
        }
      }
    } catch (err) {
      this.log.error(err);
      this.log.error(`<zwave2mqtt> error message -->> ${message}`);
    } finally {
      release();
    }
  }

  async onUnload(callback) {
    // Close MQTT connections
    if (["exmqtt", "intmqtt"].includes(this.config.connectionType)) {
      if (mqttClient && !mqttClient.closed) {
        try {
          if (mqttClient) {
            mqttClient.end();
          }
        } catch (e) {
          this.log.error(e);
        }
      }
    }
    // Internal or Dummy MQTT-Server
    if (this.config.connectionType == "intmqtt" || this.config.dummyMqtt == true) {
      try {
        if (mqttServerController) {
          mqttServerController.closeServer();
        }
      } catch (e) {
        this.log.error(e);
      }
    }
    // Set all device available states of false
    try {
      if (statesController) {
        await statesController.setAllAvailableToFalse();
      }
    } catch (e) {
      this.log.error(e);
    }

    this.setState("info.connection", false, true);

    callback();
  }

  async onStateChange(id, state) {
    if (state && state.ack == false) {
      if (id.endsWith("info.debugId")) {
        logCustomizations.debugDevices = state.val.toLowerCase();
        this.setState(id, state.val, true);
        return;
      }

      let message;
      const obj = await this.getObjectAsync(id);
      if (obj) {
          const nativeObj= obj.native || {};

          const m = id.match(/nodeID_0*(\d+)/i);
          const nodeId = m ? Number(m[1]) : null;

          message = {
              messageId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
              command: "node.set_value",
              nodeId: nodeId,
              valueId: nativeObj.valueId,
              value: state.val
            }
      }
      this.setStateChanged('info.debugmessages', JSON.stringify(message), true);

      this.log.debug(`<zwave2mqtt> error message ${message}`);

      websocketController.send(JSON.stringify(message));
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<core.AdapterOptions>} [options]
   */
  module.exports = (options) => new zwave2mqtt(options);
} else {
  // otherwise start the instance directly
  new zwave2mqtt();
}
