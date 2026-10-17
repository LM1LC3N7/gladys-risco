// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the panel, its partitions and zones.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceChanged(device));
  gladys.onDeviceUpdated((device) => app.deviceChanged(device));

  // The buttons (arm away, arm stay, disarm, bypass, unbypass).
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Scene actions.
  gladys.onSceneAction(SCENE_ACTIONS.ARM, async (fields) => {
    await app.arm(fields.partition ?? '1', fields.mode ?? 'armed_away');
    return undefined;
  });
  gladys.onSceneAction(SCENE_ACTIONS.DISARM, async (fields) => {
    await app.disarm(fields.partition ?? '1');
    return undefined;
  });

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle: the first connection starts, a reconnection resends.
  gladys.on('connected', async () => {
    try {
      await app.connected(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
