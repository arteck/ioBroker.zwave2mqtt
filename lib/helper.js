const utils = require("./utils");
const constant = require("./constants");

/*
options:
write //set common write variable to true
forceIndex //instead of trying to find names for array entries, use the index as the name
channelName //set name of the root channel
preferedArrayName //set key to use this as an array entry name
autoCast (true false) // make JSON.parse to parse numbers correctly
descriptions: Object of names for state keys
*/
/**
 *
 */
class Helper {
  /**
   *
   * @param adapter
   * @param alreadyCreatedObjects
   */
  constructor(adapter, alreadyCreatedObjects = {}) {
    this.adapter = adapter;
    this.alreadyCreatedObjects = alreadyCreatedObjects;

  }

  /**
   *
   * @param path
   * @param element
   * @param options
   */
  async parse(path, element, options = { write: false }) {
    let parsePath = path;

    if (element == null) {
      this.adapter.log.debug(`Cannot extract empty: ${parsePath}`);
      return;
    }

    let nodeId = parsePath.split(".")[0];

    if (!nodeId.includes("node")) {
      const element1 = path.split("/")[0];
      if (utils.isNumeric(element1)) {
        nodeId = utils.padNodeId(`nodeID_${element1}`);
      }
    }

    // create node
    if (typeof element === "object" && element?.productLabel) {
        await this.adapter.setObjectNotExistsAsync(nodeId, {
          type: "device",
          common: {
            name: element.name ?? element.productLabel ?? element.manufacturer,
            statusStates: {
              onlineId: `${nodeId}.ready`,
            },
          },
          native: {},
        });

      if (!this.alreadyCreatedObjects[nodeId]) {
        await this.updateDevice(nodeId, element);      // device name anpassen
      }

      this.alreadyCreatedObjects[nodeId] = {
        mqttId: "device",
        write: false,
        subscribed: null,
      };

      await this.createReadyStatus(nodeId);

    }

    if (typeof element === "string" || typeof element === "number" || element?.commandClass) {
      let val = element ?? 0;

      if (element?.commandClass) {
        // dann ist es ein device property
        val = this.resolveCommandClassValue(element) ?? 0;

        parsePath = `${nodeId}.${element.commandClassName}.${element.propertyName
                              .replace(/[^\p{L}\p{N}\s]/gu, "")
                              .replace(/\s+/g, " ")
                              .trim()}`;

        if (element?.propertyKeyName) {
parsePath = `${parsePath}.${element.propertyKeyName   
                              .replace(/[^\p{L}\p{N}\s]/gu, "")
                              .replace(/\s+/g, " ")
                              .trim()}`;
        }

        if (constant.RGB.includes(element.propertyKeyName)) {
          parsePath = utils.replaceLastDot(parsePath);
        }
      }

      if (!this.alreadyCreatedObjects[parsePath]) {
        try {
          let common = {};
          if (typeof element === "string" || typeof element === "number") {
            common = {
              id: parsePath,
              name: parsePath,
              role: this.getRole(element, options.write),
              type: typeof element,
              write: options.write,
              read: true,
            };
          } else {
            const nam_id = element.label ?? element.propertyName;
            common = {
              id: nam_id,
              name: nam_id,
              write: element.writeable,
              read: element.readable,
              desc: element.description ?? element.label,
              type: element.type === "timeout" ? "number" : element.type,
              min: element.min,
              max: element.max,
              def:
                element.default ??
                (element.type === "boolean" ? false : element.min),
              unit: element.unit ?? "",
              role: this.getRole(element, element.write ?? element.writeable),
            };

            if (common.def < element.min && element.type != "boolean") {
              common.def = element.min;
              if (val < common.def) {
                val = common.def;
              }
            }
            if (common.def > element.max && element.type != "boolean") {
              common.def = element.max;
              if (val > common.def) {
                val = common.def;
              }
            }

            if (element?.commandClass) {
              if (element.commandClassName == "manufacturer_proprietary") {
                common.name = element.propertyKeyName;
                common.desc = element.property;
              }
              if (element.list) {
                if (element.type != "boolean") {
                  common.states = utils.formatStates(element.states);
                }
              }
            }
          }

          await this.adapter.setObjectNotExistsAsync(parsePath, {
            type: "state",
            common,
            native: {
              mqttPath: utils.formatMQTT(path),
            },
          });

          this.alreadyCreatedObjects[parsePath] = {
            mqttId: utils.formatMQTT(path),
            write: common.write,
            subscribed: false,
          };
        } catch (error) {
          this.adapter.log.error(error);
        }
      }
      this.adapter.setState(parsePath, val, true);
      return;
    }
    options.channelName = utils.getLastSegment(parsePath);

    if (!this.alreadyCreatedObjects[parsePath]) {
      try {

          await this.adapter.setObjectNotExistsAsync(parsePath, {
            type: "channel",
            common: {
              name: options.channelName || "",
              write: false,
              read: true,
            },
            native: {},
          });

        this.alreadyCreatedObjects[parsePath] = {
          mqttId: "channel",
          write: false,
          subscribed: null,
        };
        delete options.channelName;
      } catch (error) {
        this.adapter.log.error(error);
      }
    }

    if (Array.isArray(element)) {
      await this.extractArray(element, "", parsePath, options);
      return;
    }

    // info schleife

    for (const key of Object.keys(element)) {
      let fullPath = `${parsePath}.${key}`;
      let value = element[key];

      if (Array.isArray(value)) {
        try {
          if (!constant.noInfoDP.includes(key)) {
            await this.extractArray(element, key, parsePath, options);
          }
        } catch (error) {
          this.adapter.log.error(`extractArray ${error}`);
        }
        continue;
      }

      const isObj = this.isObject(value);

      if (isObj) {
        if (Object.keys(value).length > 0) {
          options.write = false;
          await this.parse(fullPath, value, options);
        }
        continue;
      }

      switch (key) {
        case "ready":
          fullPath = fullPath.replace(".info.", ".");
          break;
        case "status":
          fullPath = fullPath.replace(".info.", ".");
          if (utils.isNumeric(value)) {
            value = utils.getStatusText(value);
          }
          break;
        default:
            break;
      }

      if (!this.alreadyCreatedObjects[fullPath]) {
        const objectName = options.descriptions?.[key] || key;
        let type = typeof value === "string" ? "mixed" : (value != null ? typeof value : "mixed");

        if (!constant.mixedType.includes(key)) {
          type = "mixed";
        }

        const common = {
          id: objectName,
          name: objectName,
          role: this.getRole(value, options, key),
          type,
          write: options.write,
          read: true,
        };

          await this.adapter.setObjectNotExistsAsync(fullPath, {
            type: "state",
            common,
            native: {
              mqttPath: utils.formatMQTT(fullPath),
            },
          });

        this.alreadyCreatedObjects[fullPath] = {
          mqttId: utils.formatMQTT(path),
          write: common.write,
          subscribed: false,
        };
      }

      try {
        if (value !== undefined) {
          this.adapter.setState(fullPath, value, true);
        }
      } catch (err) {
        this.adapter.log.warn(`ERROR ${value} ${JSON.stringify(err)}`);
      }
    }
  }

  /**
   *
   * @param value
   */
  isObject(value) {
    return value !== null && typeof value === "object";
  }

  /**
   *
   * @param element
   * @param key
   * @param path
   * @param options
   */
  async extractArray(element, key, path, options) {
    try {
      const array = key ? element[key] : element;

      for (let i = 0; i < array.length; i++) {
        const arrayElement = array[i];
        const index = (i + 1).toString().padStart(2, "0");

        if (typeof arrayElement === "string") {
          if (key == undefined || key === "") {
            key = arrayElement;
          }

          await this.parse(
            `${path}.${key}.${arrayElement}`,
            arrayElement,
            options,
          );
          continue;
        }

        await this.parse(`${path}.${key}`, arrayElement, options);
      }
    } catch (error) {
      this.adapter.log.error(`Cannot extract array ${path}`);
    }
  }

  /**
   *
   * @param element
   * @param options
   * @param dpName
   */
  getRole(element, options, dpName) {
    const write = options.write;
    const hasStates =
      element && typeof element === "object" && element.states !== undefined;

    if (constant.timeKey.includes(dpName)) {
      // check ob es sich um ein timestamp handelt
      return "value.time";
    }

    if (typeof element === "boolean" && !write) {
      return "indicator";
    }

    if (hasStates) {
      if (element.type == "boolean") {
        delete element.states;
        return "button";
      }
      return "switch";
    }

    if (typeof element === "boolean" && !write) {
      return "indicator";
    }
    if (typeof element === "boolean" && write) {
      return "switch";
    }
    if (typeof element === "number" && !write) {
      return "value";
    }
    if (typeof element === "number" && write) {
      return "level";
    }
    if (typeof element === "string") {
      return "text";
    }

    return "state";
  }
  /**
   *
   * @param element
   */
  resolveCommandClassValue(element) {
    const type = element.type;

    if (type === "any" || type === "color") {
      element.type = "mixed";
      return typeof element.value === "object"
        ? JSON.stringify(element.value)
        : element.value;
    }

    if (type.includes("string")) {
      element.type = "mixed";
      if (element.writeable === false) {
        let v = element.value ?? element.min ?? 0;
        if (Array.isArray(v) && v.length) {
          v = JSON.stringify(v);
        }
        return v;
      }
      return element.value ?? element.min ?? 0;
    }

    if (type.includes("buffer")) {
      element.type = "mixed";
      if (element.writeable === false) {
        let v = element.value ?? element.min ?? 0;
        if (Array.isArray(v) && v.length) {
          v = v[0];
        }
        return v;
      }
      return element.value ?? element.min ?? 0;
    }

    if (type === "duration") {
      element.type = "mixed";
      let v = element.value ?? element.min ?? 0;
      if (typeof v === "object") {
        if (v?.unit) {
          element.unit = v.unit;
        }
        v = 0;
      }
      return v;
    }

    if (type === "number") {
      if (element?.value) {
        return utils.isNumeric(element.value) ? element.value : 0;
      }
      return element.value ?? element.min;
    }

    return element.readable === false
      ? false
      : (element.value ?? (type === "boolean" ? false : (element.min ?? 0)));
  }
  /**
   *
   * @param id
   * @param state
   */
  async createZ2mMessage(id, state) {

    const mqttId = await this.adapter.getObjectAsync(id) ?? "";

    this.adapter.log.debug(`<zwave2mqtt> createZ2mMessage for ID : ${id} -> ${JSON.stringify(mqttId)}`);

/*
    const idCorr = id?.startsWith("zwave2mqtt.0.") ? id.slice("zwave2mqtt.0.".length) : id;

    let rawMqttId;
    try {
      rawMqttId =
        this.alreadyCreatedObjects?.[id]?.mqttId ??
        this.alreadyCreatedObjects?.[idCorr]?.mqttId ??

    } catch (error) {
      this.adapter.log.error(`<zwave2mqtt> createZ2mMessage : ${id}`);
    }

    const mqttId = this.unpadNodeIdInMqttId(rawMqttId);
*/
    return {
      payload: { value: state?.val },
      topic: `${mqttId.native.mqttPath}/set`,
    };
  }

  /**
   *
   * @param mqttId
   */
  unpadNodeIdInMqttId(mqttId) {
    return mqttId.replace(/^([^\/]+)_(\d+)(?=\/|$)/, (match, prefix, num) => {
      if (prefix.toLowerCase() === "nodeid") {
        return `${prefix}_${parseInt(num, 10)}`;
      }
      return match;
    });
  }

  /**
   *
   * @param nodeId
   */
  async createReadyStatus(nodeId) {
     // leg die status direkt auch an
      let common = {
        id: 'ready',
        name: 'ready',
        role: 'indicator',
        type: 'boolean',
        write: false,
        read: true,
      };
      await this.adapter.setObjectNotExistsAsync(`${nodeId}.ready`, {
        type: "state",
        common,
        native: {},
      });

      common = {
        id: 'status',
        name: 'status',
        role: 'text',
        type: 'mixed',
        write: false,
        read: true,
      };

      await this.adapter.setObjectNotExistsAsync(`${nodeId}.status`, {
        type: "state",
        common,
        native: {},
      });
  }

  /**
   *
   * @param nodeId
   * @param element
   */
  async updateDevice(nodeId, element) {
    const obj = await this.adapter.getObjectAsync(nodeId);
    if (obj) {
      const newName = element.name || element.productLabel || element.manufacturer || element.newValue;

      if (obj.common?.name !== newName) {
        obj.common = obj.common ?? {};
        obj.common.name = newName;

        await this.adapter.setObjectAsync(nodeId, obj);
      }
    }
  }

}

module.exports = {
  Helper: Helper,
};
