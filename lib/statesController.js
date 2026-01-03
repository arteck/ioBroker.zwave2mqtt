/**
 *
 */
class StatesController {
  /**
   *
   * @param adapter
   * @param deviceCache
   */
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   *
   * @param stateName
   * @param value
   */
  async setStateSafelyAsync(stateName, value) {
    if (value === undefined || value === null) {
      return;
    }
    await this.adapter.setStateAsync(stateName, value, true);
  }

  /**
   *
   * @param stateName
   * @param value
   */
  async setStateChangedSafelyAsync(stateName, value) {
    if (value === undefined || value === null) {
      return;
    }
    await this.adapter.setStateChangedAsync(stateName, value, true);
  }

  /**
   *
   * @param deviceCache
   */
  async subscribeWritableStates(deviceCache) {
    for (const [fullKey, meta] of Object.entries(deviceCache)) {
      const { mqttId, write, subscribed } = meta;

      if (write && !subscribed) {
        this.adapter.subscribeStates(fullKey);
        meta.subscribed = true;
      }
    }
    this.adapter.subscribeStates("info.debugId");
  }

  /**
   *
   * @param deviceCache
   */
  async subscribeAllWritableExistsStates() {
    const writableStates = {};

    const res = await this.adapter.getObjectViewAsync("system", "state", {
      startkey: "zwave2mqtt.",
      endkey: "zwave2mqtt.\u9999",
    });

    for (const row of res.rows) {
      const obj = row.value;
      if (obj?.common?.write === true) {
        writableStates[obj._id] = {
          mqttId: obj.native.mqttPath,
          write: true,
          subst: null,
        };
      }
    }

    return writableStates;
  }

  /**
   *
   */
  async setAllAvailableToFalse() {
    const readyStates = await this.adapter.getStatesAsync("*.ready");
    for (const readyState in readyStates) {
      await this.adapter.setStateChangedAsync(readyState, false, true);
    }
    const availableStates = await this.adapter.getStatesAsync("*.status");
    for (const availableState in availableStates) {
      await this.adapter.setStateChangedAsync(availableState, "unknown", true);
    }
  }
}

module.exports = {
  StatesController,
};
