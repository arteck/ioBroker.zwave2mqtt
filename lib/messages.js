/**
 *
 * @param config
 * @param log
 */
async function adapterInfo(config, log) {
  log.info(
    "================================= Adapter Config =================================",
  );
  log.info(`|| Zwave2MQTT Frontend Scheme: ${config.webUIScheme}`);
  log.info(`|| Zwave2MQTT Frontend Server: ${config.webUIServer}`);
  log.info(`|| Zwave2MQTT Frontend Port: ${config.webUIPort}`);
  log.info(`|| Zwave2MQTT Connection Type: ${config.connectionType}`);
  if (config.connectionType == "ws") {
    log.info(`|| Zwave2MQTT Websocket Scheme: ${config.wsScheme}`);
    log.info(`|| Zwave2MQTT Websocket Server: ${config.wsServerIP}`);
    log.info(`|| Zwave2MQTT Websocket Port: ${config.wsServerPort}`);
    log.info(
      `|| Zwave2MQTT Websocket Auth-Token: ${config.wsTokenEnabled ? "use" : "unused"}`,
    );
    log.info(
      `|| Zwave2MQTT Websocket Dummy MQTT-Server: ${config.dummyMqtt ? "activated" : "deactivated"}`,
    );
    if (config.dummyMqtt == true) {
      log.info(`|| Zwave2MQTT Dummy MQTT IP-Bind: ${config.mqttServerIPBind}`);
      log.info(`|| Zwave2MQTT Dummy MQTT Port: ${config.mqttServerPort}`);
    }
  } else if (config.connectionType == "exmqtt") {
    log.info(
      `|| Zwave2MQTT Externanl MQTT Server: ${config.externalMqttServerIP}`,
    );
    log.info(
      `|| Zwave2MQTT Externanl MQTT Port: ${config.externalMqttServerPort}`,
    );
    log.info(
      `|| Zwave2MQTT Externanl MQTT Credentials: ${config.externalMqttServerCredentials ? "use" : "unused"}`,
    );
  } else if (config.connectionType == "intmqtt") {
    log.info(`|| Zwave2MQTT Internal MQTT IP-Bind: ${config.mqttServerIPBind}`);
    log.info(`|| Zwave2MQTT Internal MQTT Port: ${config.mqttServerPort}`);
  }
  log.info(
    "==================================================================================",
  );
}

module.exports = {
  adapterInfo,
};
