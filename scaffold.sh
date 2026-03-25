#!/bin/bash

set -e

if [ -z "$COMPOSIO_API_KEY" ]; then
	echo "Error: COMPOSIO_API_KEY is not set" >&2
	exit 1
fi

echo "Creating auth configs for Gmail and Google Calendar..."

bun -e "
import { Composio } from '@composio/core';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

const gmailAuthConfig = await composio.authConfigs.create('gmail', {
  name: 'Endpoint Tester Gmail Auth',
  type: 'use_composio_managed_auth',
});

const calendarAuthConfig = await composio.authConfigs.create('googlecalendar', {
  name: 'Endpoint Tester Calendar Auth',
  type: 'use_composio_managed_auth',
});

const envContent = \`COMPOSIO_API_KEY=\${process.env.COMPOSIO_API_KEY}
GMAIL_AUTH_CONFIG_ID=\${gmailAuthConfig.id}
GOOGLECALENDAR_AUTH_CONFIG_ID=\${calendarAuthConfig.id}\`;

await Bun.write('.env', envContent);
console.log('Auth configs created:');
console.log('  Gmail:', gmailAuthConfig.id);
console.log('  Google Calendar:', calendarAuthConfig.id);
console.log('env file written.');
"
