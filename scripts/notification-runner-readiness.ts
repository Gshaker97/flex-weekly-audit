/** Inert inventory only. No arguments, files, credentials, database or network are read. */
import { notificationRunnerReadiness } from "../lib/notification-runner";
console.log(JSON.stringify(notificationRunnerReadiness(), null, 2));
