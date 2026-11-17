import { basename, join } from "node:path";
import { ConfirmQueue } from "./confirmQueue.js";
import { SOUND_CATEGORIES, pickRandomWav } from "./sounds.js";

const CONFIRM_RESULTS = new Set(["yes", "no", "timeout"]);

/** The app's state and decisions; the HTTP server and the helper only talk to this. */
export function createApp({ config, helper, version, loadState, saveState, onExit, onRestart = () => {},
  logger = console, pickWav = pickRandomWav, maxPending = 10 }) {
  let soundEnabled = loadState().soundEnabled;
  let consoleUrl = null;
  let helperReady = false;

  function playFrom(dir) {
    if (!soundEnabled) return { played: false, reason: "muted" };
    const file = pickWav(dir);
    if (!file) return { played: false, reason: "no-sounds" };
    helper.send({ cmd: "play", path: file });
    return { played: true, file: basename(file) };
  }

  const queue = new ConfirmQueue({
    max: maxPending,
    timeoutSec: config.confirmTimeoutSec,
    onShow: (item, waiting) => {
      playFrom(config.confirmSoundDir);
      helper.send({ cmd: "confirm", id: item.id, url: item.url, timeoutSec: config.confirmTimeoutSec, waiting });
    },
    onWaiting: (id, count) => helper.send({ cmd: "waiting", id, count }),
    onCancel: id => helper.send({ cmd: "cancel", id })
  });

  return {
    playCategory(category) {
      if (!SOUND_CATEGORIES.includes(category)) return { played: false, reason: "unknown-category" };
      return playFrom(join(config.soundsDir, category));
    },

    requestOpen(url) {
      if (!helperReady) return { id: 0, promise: Promise.resolve("helper-restarted") };
      const ticket = queue.enqueue(url);
      if (!ticket) return null;
      return {
        id: ticket.id,
        promise: ticket.promise.then(result => {
          if (result === "yes" && !helper.send({ cmd: "open", url })) return "helper-restarted";
          return result;
        })
      };
    },

    cancelOpen(id) {
      queue.cancel(id);
    },

    setConsoleUrl(url) {
      consoleUrl = url;
      helper.send({ cmd: "consoleUrl", url });
      return consoleUrl;
    },

    health() {
      return {
        ok: true, version, port: config.port, soundEnabled,
        consoleUrl: consoleUrl !== null, pendingConfirms: queue.size
      };
    },

    handleHelperMessage(message) {
      switch (message.event) {
        case "ready":
          helperReady = true;
          helper.send({ cmd: "init", header: `AI Center · port ${config.port}`, soundEnabled });
          helper.send({ cmd: "consoleUrl", url: consoleUrl });
          break;
        case "confirm":
          if (CONFIRM_RESULTS.has(message.result)) queue.resolve(message.id, message.result);
          break;
        case "toggleSound":
          soundEnabled = !soundEnabled;
          try {
            saveState({ soundEnabled });
          } catch (error) {
            logger.error(`Cannot save state: ${error.message}`);
          }
          helper.send({ cmd: "soundEnabled", value: soundEnabled });
          break;
        case "exit":
          onExit();
          break;
        case "restart":
          onRestart();
          break;
        case "log":
          logger.log(`[helper] ${message.message}`);
          break;
        default:
          break;
      }
    },

    handleHelperDown() {
      helperReady = false;
      queue.failAll("helper-restarted");
    },

    shutdown() {
      queue.failAll("shutdown");
    }
  };
}
