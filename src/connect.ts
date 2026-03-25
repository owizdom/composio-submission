import { Composio } from "@composio/core";

const composio = new Composio();

const gmailAuthConfigId = process.env.GMAIL_AUTH_CONFIG_ID;
const calendarAuthConfigId = process.env.GOOGLECALENDAR_AUTH_CONFIG_ID;

if (!gmailAuthConfigId || !calendarAuthConfigId) {
  throw new Error(
    "Auth config IDs not set. Run `COMPOSIO_API_KEY=<key> sh scaffold.sh` first."
  );
}

const USER_ID = "candidate";

console.log("Connecting Gmail account...");
const gmailLink = await composio.connectedAccounts.link(
  USER_ID,
  gmailAuthConfigId
);
console.log("Open this URL to connect Gmail:", gmailLink);
await gmailLink.waitForConnection();
console.log("Gmail connected!\n");

console.log("Connecting Google Calendar account...");
const calendarLink = await composio.connectedAccounts.link(
  USER_ID,
  calendarAuthConfigId
);
console.log("Open this URL to connect Calendar:", calendarLink);
await calendarLink.waitForConnection();
console.log("Google Calendar connected!\n");

console.log("Both accounts connected. You can now build and run your endpoint tester agent.");
