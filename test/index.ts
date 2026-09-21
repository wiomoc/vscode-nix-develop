import { report } from "./harness";
import { run as runEnv } from "./env.test";
import {
  run as runRemote,
  runFlakeRefs,
  runFailureClassification,
  runNixCommands,
  runFlakeSettings,
  runNixExtensions,
  runServerLifecycle,
  runProductDetection,
  runDistributionLayout,
  runServerAcquisition,
} from "./remote.test";
import { run as runActivation } from "./activation.test";
import { run as runDirenv } from "./direnv.test";
import { run as runSession } from "./session.test";
import { run as runFlakeWatch } from "./flake-watch.test";
import { run as runRecover } from "./recover.test";
import { run as runSource } from "./source.test";
import { run as runSettings } from "./settings.test";
import { run as runProfiles } from "./profile.test";
import { run as runBuildTerminal } from "./build-terminal.test";
import { run as runPty } from "./pty.test";
import { run as runNix } from "./nix.e2e.test";
import { run as runServer, runIdleShutdown } from "./server.e2e.test";

async function main(): Promise<void> {
  await runEnv();
  await runRemote();
  await runFlakeRefs();
  await runFailureClassification();
  await runNixCommands();
  await runServerLifecycle();
  await runProductDetection();
  await runDistributionLayout();
  await runServerAcquisition();
  await runNixExtensions();
  await runFlakeSettings();
  await runDirenv();
  await runSession();
  await runFlakeWatch();
  await runActivation();
  await runRecover();
  await runSource();
  await runSettings();
  await runProfiles();
  await runBuildTerminal();
  await runPty();
  await runNix();
  await runServer();
  await runIdleShutdown();
  report();
}

void main();
