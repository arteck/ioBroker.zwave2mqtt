"use strict";

const core = require("@iobroker/adapter-core");
const mqtt = require("mqtt");
const utils = require("./lib/utils");
const constant = require("./lib/constants");

const adapterInfo = require("./lib/messages").adapterInfo;
const StatesController = require("./lib/statesController").StatesController;
const Helper = require("./lib/helper").Helper;

const MqttServerController =
  require("./lib/mqttServerController").MqttServerController;

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

    deviceCache = await statesController.subscribeAllWritableExistsStates();
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
          clean: true,
          reconnectPeriod: 500,
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
        this.log.info(
          `Connect to zwave2MQTT over ${this.config.connectionType == "exmqtt" ? "external mqtt" : "internal mqtt"} connection.`,
        );
      });

      mqttClient.subscribe(`${this.config.baseTopic}/#`);

      this.setState("info.connection", true, true);

      mqttClient.on("message", (topic, payload) => {
        const newMessage = `{"payload":${payload.toString() == "" ? '"null"' : payload.toString()},"topic":"${topic.slice(topic.search("/") + 1)}"}`;
        this.messageParse(newMessage);
      });
    }
  }

  async messageParse(message) {
    let nodeId;
    let statusText;
    let parsePath;
    let value_update;

    // Mutex lock: queue up calls to messageParse
    let release;
    const lock = new Promise((resolve) => (release = resolve));
    const prev = messageParseMutex;
    messageParseMutex = lock;
    await prev;

    try {
      const messageObj = JSON.parse(message);

      const nodeElement = messageObj.topic.split("/")[0];
      if (utils.isNumeric(nodeElement)) {
        nodeId = utils.padNodeId(`nodeID_${nodeElement}`);
      }

      if (logCustomizations.debugDevices.length > 0) {
        if (message.toLowerCase().includes(logCustomizations.debugDevices.toLowerCase())) {
          this.log.warn(
            `<<<--- zwave2mqtt ---> DEBUGMESSAGE -->>  ${JSON.stringify(
              messageObj.payload,
            )}`,
          );
        }
      }

      this.log.debug(`<zwave2mqtt>  1-topic : ${messageObj.topic}`);
      this.log.debug(`<zwave2mqtt> 2-payload : ${messageObj.payload}`);

      options = { write: false };

      // <mqtt_prefix>/_EVENTS_/ZWAVE_GATEWAY-<mqtt_name>/<driver|node|controller>/<event_name>
      // <mqtt_prefix>/_CLIENTS/ZWAVE_GATEWAY-<mqtt_name>/api/<api_name>/set
      const topicEvent = messageObj.topic.split("/")[0];
      const topicGateway = messageObj.topic.split("/")[1];
      const topicType = messageObj.topic.split("/")[2];
      const topicEventName = messageObj.topic.split("/")[3];
      let value_update;

      if (this.config.renewNodeInfo) {
        for (const deviceKey in deviceCache) {
          if (deviceKey.includes(nodeId)) {
            delete deviceCache[deviceKey];
          }
        }
      }

      switch (topicEvent) {
        case "_EVENTS":
          {
            const infoPayload = messageObj.payload?.data?.[0] || {};
            nodeId = utils.padNodeId(`nodeID_${infoPayload.id}`);
            switch (topicType) {
              case "node":
                switch (topicEventName) {
                  case "node_interview_started":
                  case "node_removed":
                    delete nodeCache[nodeId];

                    for (const deviceKey in deviceCache) {
                      if (deviceKey.includes(nodeId)) {
                        delete deviceCache[deviceKey];
                      }
                    }

                    if (topicEventName === "node_interview_started") {
                      this.log.info(`Node Interview started for ${nodeId}, clearing cache to re-create states.`);
                      await this.delObjectAsync(nodeId, { recursive:true }); // delete all states of the node
                    }

                    if (topicEventName === "node_removed") {
                      this.log.info(`Node ${nodeId} removed, clearing all states manually.`);

                      const obj = await this.adapter.getObjectAsync(nodeId);
                      if (obj) {
                        if (this.config.useEventInDesc) {
                          obj.common.desc = "Device removed by Z-Wave network";
                        } else {
                          obj.common.name = "Device removed";
                        }
                        obj.common = obj.common ?? {};
                        await this.setObjectAsync(nodeId, obj);
                      }
                    }

                    break;
                  case "statistics_updated":
                    if (infoPayload?.ready) {
                      await this.setStateAsync(`${nodeId}.ready`, infoPayload?.ready, true);
                    }
                    if (infoPayload?.status) {
                      statusText = infoPayload.status;
                      if (utils.isNumeric(statusText)) {
                        statusText = utils.getStatusText(statusText);
                      }
                      await this.setStateAsync(`${nodeId}.status`, statusText, true);
                    }
                    break;
                  case "node_wake_up":
                  case "node_sleep":
                  case "node_interview_failed":
                  case "node_added":
                  case "node_interview_completed":
                    if (infoPayload?.ready) {
                      await this.setStateAsync(`${nodeId}.ready`, infoPayload?.ready, true);
                    }
                    if (infoPayload?.status) {
                      statusText = infoPayload.status;
                      if (utils.isNumeric(statusText)) {
                        statusText = utils.getStatusText(statusText);
                      }
                      await this.setStateAsync(`${nodeId}.status`, statusText, true);
                    }
                    if (!nodeCache[nodeId]) {
                      if (this.config.showNodeInfoMessage) {
                         this.log.info(`Node Info Update for ${nodeId}`);
                      }
                      nodeCache[nodeId] = {nodeId: nodeId};
                    }
                    await helper.parse(`${nodeId}.info`, messageObj.payload?.data[0], options);

                    break;
                  case "node_metadata_updated":
                    break;
                  case "node_value_updated":
                    if (infoPayload?.ready) {
                      await this.setStateAsync(`${nodeId}.ready`, infoPayload?.ready, true);
                    }
                    if (infoPayload?.status) {
                      statusText = infoPayload.status;
                      if (utils.isNumeric(statusText)) {
                        statusText = utils.getStatusText(statusText);
                      }
                      await this.setStateAsync(`${nodeId}.status`, statusText, true);
                    }

                    value_update = messageObj.payload?.data[1];
                    parsePath = `${nodeId}.${value_update.commandClassName}.${value_update.propertyName
                                          .replace(/[^\p{L}\p{N}\s]/gu, "")
                                          .replace(/\s+/g, " ")
                                          .trim()}`;

                    if (value_update?.propertyKeyName) {
                      parsePath = `${parsePath}.${value_update.propertyKeyName
                          .replace(/[^\p{L}\p{N}\s]/gu, "")
                          .replace(/\s+/g, " ")
                          .trim()}`;

                      if (constant.RGB.includes(value_update.propertyKeyName)) {
                        parsePath = utils.replaceLastDot(parsePath);
                      }
                    }

                    if (value_update.newValue !== value_update.prevValue && value_update.property !== "name") {
                      await helper.parse(`${parsePath}`, value_update.newValue, options);
                    }

                    if (value_update.property === "name") {    // sonderlocke für name änderung

                      await helper.updateDevice(nodeId, value_update);
                      // dann info aktualisieren
                      value_update = messageObj.payload?.data[0];
                      await helper.parse(`${nodeId}.info`, value_update, options);
                    }
                    break;
                  default:
                    break;
                }
                break;
              case "controller":
                  break;
              case "driver":
                  break;
              default:
                  break;
            }
          }
          break;
        case "_CLIENTS":
          switch (topicType) {
            case "status":
                 this.setStateChanged("info.zwave_gateway_status", messageObj.payload.value ? "online" : "offline", true);
                 break;
               case "version":
                this.setStateChanged("info.zwave_gateway_version", messageObj.payload.value, true);
                this.setStateChanged("info.zwave_gateway_status", "online", true);
                break;

              default:
                break;
          }
          break;
        default:
          if (nodeId != null) {
            let commandClass = messageObj.topic.split("/")[1];
            if (utils.isNumeric(commandClass)) {
              commandClass = messageObj.payload.commandClassName;
            }

            switch (commandClass) {
              case "nodeinfo":
                if (!nodeCache[nodeId]) {
                  if (this.config.showNodeInfoMessage) {
                     this.log.info(`Node Info Update for ${nodeId}`);
                  }
                  nodeCache[nodeId] = {nodeId: nodeId};
                }
                await helper.parse(`${nodeId}.info`, messageObj.payload, options);

                break;
              case "lastActive":
                if (deviceCache[`${nodeId}.info.lastActive`]) {
                  await this.setStateAsync(`${nodeId}.info.lastActive`, messageObj.payload.value, true);
                }
                break;
              case "status":
                statusText = messageObj.payload.status;
                if (utils.isNumeric(statusText)) {
                  statusText = utils.getStatusText(statusText);
                }
                await this.setStateAsync(`${nodeId}.status`, statusText, true);
                await this.setStateAsync(`${nodeId}.ready`, messageObj.payload.value, true);
                break;
              default:
                if (messageObj.topic.endsWith('/set')) {
                  this.setState("info.debugmessages",`ACK : ${nodeId} ${messageObj.topic} ${JSON.stringify(messageObj.payload)}`, true);
                } else {
                  await helper.parse(messageObj.topic, messageObj.payload, options);
                }
                break;
            }
          }
          break;
      }

      await statesController.subscribeWritableStates(deviceCache);
    } catch (err) {
      this.log.error(err);
      this.log.error(`<zwave2mqtt> error message ${message}`);
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

      const message = (await helper.createZ2mMessage(id, state)) || {
        topic: "",
        payload: "",
      };

      if (["exmqtt", "intmqtt"].includes(this.config.connectionType)) {
        mqttClient.publish(
                                  `${this.config.baseTopic}/${message.topic}`,
                                  JSON.stringify(message.payload),
        );
      }
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
