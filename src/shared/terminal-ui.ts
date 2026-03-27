/**
 * Terminal UI utilities with ASCII art and formatting
 */

// ANSI color codes
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
} as const;

// ASCII Art for POCKET SERVER
export const POCKET_SERVER_LOGO = `
${colors.brightCyan}  ___  ___   ___ _  _____ _____    ___ ___ _____   _____ ___ 
 | _ \\/ _ \\ / __| |/ / __|_   _|  / __| __| _ \\ \\ / / __| _ \\
 |  _/ (_) | (__| ' <| _|  | |   \\__ \\ _||   /\\ V /| _||   /
 |_|  \\___/ \\___|_|\\_\\___| |_|   |___/___|_|_\\ \\_/ |___|_|_\\${colors.reset}
`;

// Box drawing characters
export const box = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  cross: '┼',
  teeUp: '┴',
  teeDown: '┬',
  teeLeft: '┤',
  teeRight: '├',
} as const;

/**
 * Create a styled box with content
 */
export function createBox(content: string[], width: number = 60, title?: string): string {
  const lines: string[] = [];
  
  // Top border
  if (title) {
    const titlePadding = Math.max(0, width - title.length - 4);
    const leftPad = Math.floor(titlePadding / 2);
    const rightPad = titlePadding - leftPad;
    lines.push(`${box.topLeft}${box.horizontal.repeat(leftPad + 1)} ${colors.bright}${title}${colors.reset} ${box.horizontal.repeat(rightPad + 1)}${box.topRight}`);
  } else {
    lines.push(`${box.topLeft}${box.horizontal.repeat(width)}${box.topRight}`);
  }
  
  // Content lines
  content.forEach(line => {
    const padding = Math.max(0, width - line.length);
    lines.push(`${box.vertical} ${line}${' '.repeat(padding - 1)} ${box.vertical}`);
  });
  
  // Bottom border
  lines.push(`${box.bottomLeft}${box.horizontal.repeat(width)}${box.bottomRight}`);
  
  return lines.join('\n');
}

/**
 * Create startup banner with ASCII art and server info
 */
export function createStartupBanner(port: number, tunnelEnabled: boolean = false): string {
  const lines = [
    '',
    POCKET_SERVER_LOGO,
    '',
    `${colors.brightGreen}    🚀 Server Status: ${colors.bright}ONLINE${colors.reset}`,
    `${colors.brightBlue}    📡 Port: ${colors.bright}${port}${colors.reset}`,
    `${colors.brightYellow}    🔗 WebSocket: ${colors.bright}ws://localhost:${port}/ws${colors.reset}`,
    `${colors.brightMagenta}    💚 Health Check: ${colors.bright}http://localhost:${port}/health${colors.reset}`,
    '',
  ];
  
  if (tunnelEnabled) {
    lines.splice(-1, 0, `${colors.brightCyan}    🌐 Remote Tunnel: ${colors.bright}ENABLED${colors.reset}`);
  }
  
  return lines.join('\n');
}

/**
 * Create network URLs display
 */
export function createNetworkInfo(urls: string[]): string {
  if (urls.length === 0) return '';
  
  const lines = [
    `${colors.brightCyan}🔗 Local Network Access:${colors.reset}`,
    ...urls.map(url => `   ${colors.gray}•${colors.reset} ${colors.bright}${url}${colors.reset}`)
  ];
  
  return lines.join('\n');
}

/**
 * Create pairing mode display
 */
export function createPairingDisplay(pin: string, expiresInSec: number, lanUrls: string[] = [], isRemote: boolean = false): string {
  const content = [
    `${colors.brightYellow}🔐 PAIRING MODE ACTIVE${colors.reset}`,
    '',
    `${colors.bright}PIN Code: ${colors.brightGreen}${pin}${colors.reset}`,
    `${colors.bright}Expires in: ${colors.brightYellow}${expiresInSec}s${colors.reset}`,
    '',
  ];
  
  if (isRemote) {
    content.push(`${colors.brightCyan}🌐 Remote pairing mode: ${colors.reset}${colors.bright}use PIN + Token${colors.reset}`);
  } else if (lanUrls.length > 0) {
    content.push(`${colors.brightCyan}📱 Connect from these URLs:${colors.reset}`);
    lanUrls.forEach(url => {
      content.push(`   ${colors.gray}•${colors.reset} ${colors.bright}${url}${colors.reset}`);
    });
  }
  
  return createBox(content, 50, 'DEVICE PAIRING');
}

/**
 * Create CLI help display
 */
export function createHelpDisplay(): string {
  return `
${colors.brightCyan}╭──────────────────────────────────────────────────────╮
│                                                      │
│  ${colors.bright}POCKET SERVER${colors.reset}${colors.brightCyan} - Command Line Interface           │
│                                                      │
╰──────────────────────────────────────────────────────╯${colors.reset}

${colors.bright}USAGE:${colors.reset}
  ${colors.brightGreen}pocket-server${colors.reset} ${colors.gray}<command>${colors.reset} ${colors.dim}[flags]${colors.reset}

${colors.bright}COMMANDS:${colors.reset}
  ${colors.brightGreen}start${colors.reset}      Start the server
  ${colors.brightGreen}pair${colors.reset}       Start server and open pairing window  
  ${colors.brightGreen}stop${colors.reset}       Stop a running server
  ${colors.brightGreen}update${colors.reset}     Update to latest release via installer
  ${colors.brightGreen}terminal${colors.reset}   Terminal utilities (${colors.dim}sessions, attach, select${colors.reset})
  ${colors.brightGreen}help${colors.reset}       Show this help

${colors.bright}FLAGS:${colors.reset}
  ${colors.brightYellow}--port, -p${colors.reset} ${colors.gray}<n>${colors.reset}   Port to listen on ${colors.dim}(default: 3000 or $PORT)${colors.reset}
  ${colors.brightYellow}--remote, -r${colors.reset}        Start Cloudflare tunnel (start) or enable remote pairing (pair)
  ${colors.brightYellow}--no-auto-update${colors.reset}    Skip pre-start update check
  ${colors.brightYellow}--duration${colors.reset} ${colors.gray}<ms>${colors.reset}   Pairing window duration ${colors.dim}(pair only; default: 60000)${colors.reset}
  ${colors.brightYellow}--pin${colors.reset} ${colors.gray}<code>${colors.reset}        Override generated PIN ${colors.dim}(pair only)${colors.reset}
  ${colors.brightYellow}--help, -h${colors.reset}          Show this help

${colors.bright}EXAMPLES:${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server start${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server start${colors.reset} ${colors.brightYellow}--port${colors.reset} ${colors.gray}3010${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server start${colors.reset} ${colors.brightYellow}-p=3010${colors.reset} ${colors.brightYellow}--remote${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server pair${colors.reset} ${colors.brightYellow}--duration${colors.reset} ${colors.gray}120000${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server pair --remote${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server terminal sessions${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server terminal attach${colors.reset} ${colors.gray}--index 2${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server terminal attach${colors.reset} ${colors.gray}"Opencode"${colors.reset}
  ${colors.gray}$${colors.reset} ${colors.brightGreen}pocket-server terminal attach${colors.reset} ${colors.gray}--name "Opencode"${colors.reset}
`;
}

/**
 * Create shutdown banner
 */
export function createShutdownBanner(): string {
  return `
${colors.brightYellow}╭──────────────────────────────────────────╮
│                                          │
│  ${colors.bright}📛 POCKET SERVER SHUTTING DOWN${colors.reset}${colors.brightYellow}      │
│                                          │
╰──────────────────────────────────────────╯${colors.reset}

${colors.gray}Cleaning up resources...${colors.reset}
`;
}

/**
 * Status message formatters
 */
export const status = {
  starting: (port: number, tunnel: boolean = false) => 
    `${colors.brightBlue}🚀 Starting Pocket Server on port ${colors.bright}${port}${colors.reset}${tunnel ? colors.brightCyan + ' (remote tunnel enabled)' + colors.reset : ''}...`,
  
  tunnelReady: (url: string) => 
    `${colors.brightCyan}🌐 Public URL: ${colors.bright}${url}${colors.reset}`,
  
  tunnelFailed: (error: string) => 
    `${colors.brightRed}❌ Failed to start Cloudflare Tunnel: ${colors.reset}${error}`,
  
  stopping: () => 
    `${colors.brightYellow}🛑 Stopping server...${colors.reset}`,
  
  stopped: () => 
    `${colors.brightGreen}✅ Server stopped successfully${colors.reset}`,
  
  notRunning: () => 
    `${colors.gray}ℹ️  No running server found${colors.reset}`,
  
  updating: () => 
    `${colors.brightBlue}📦 Fetching and running installer to update...${colors.reset}`,
  
  unknownCommand: (cmd: string) => 
    `${colors.brightRed}❌ Unknown command: ${colors.bright}${cmd}${colors.reset}`,
};

/**
 * Format log level with colors
 */
export function formatLogLevel(level: string): string {
  switch (level.toUpperCase()) {
    case 'DEBUG':
      return `${colors.gray}DEBUG${colors.reset}`;
    case 'INFO':
      return `${colors.brightBlue}INFO ${colors.reset}`;
    case 'WARN':
      return `${colors.brightYellow}WARN ${colors.reset}`;
    case 'ERROR':
      return `${colors.brightRed}ERROR${colors.reset}`;
    default:
      return level.padEnd(5);
  }
}

/**
 * Format category with colors
 */
export function formatCategory(category: string): string {
  const categoryColors: Record<string, string> = {
    'HTTP': colors.brightGreen,
    'WebSocket': colors.brightCyan,
    'Terminal': colors.brightMagenta,
    'Agent': colors.brightYellow,
    'Tunnel': colors.brightBlue,
    'Auth': colors.brightRed,
    'CloudCursor': colors.brightCyan,
    'GitHub': colors.gray,
    'Notifications': colors.brightMagenta,
  };
  
  const color = categoryColors[category] || colors.white;
  return `${color}${category.padEnd(12)}${colors.reset}`;
}
