#!/usr/bin/env node

const path = require('path');
const args = process.argv.slice(2);

// If no arguments or just help/version flags, default to 'web' command for backward compatibility
if (args.length === 0 ||
    args[0] === '--help' ||
    args[0] === '-h' ||
    args[0] === '--version' ||
    args[0] === '-v') {

  // Default to web service when no command specified
  const { startServer } = require(path.join(__dirname, '..', 'lib', 'web', 'index.js'));

  if (args.length > 0 && (args[0].startsWith('-'))) {
    // Pass flags like --help to the main CLI
    process.argv = ['node', path.join(__dirname, '..', 'lib', 'index.js'), ...args];
    require(path.join(__dirname, '..', 'lib', 'index.js'));
  } else {
    startServer();
  }
} else if (args[0] === 'review' || args[0] === 'web') {
  // Pass subcommands to the main CLI which handles them via Commander.js
  process.argv = ['node', path.join(__dirname, '..', 'lib', 'index.js'), ...args];
  require(path.join(__dirname, '..', 'lib', 'index.js'));
} else {
  console.error('Usage: ai-code-reviewer <command>');
  console.error('');
  console.error('Commands:');
  console.error('  review [options]       Run a one-off code review for a specific MR');
  console.error('  web [options]          Start webhook listener for GitLab MR events');
  console.error('');
  console.error('Options:');
  console.error('  --help, -h             Show help');
  console.error('  --version, -v          Show version number');
  process.exit(1);
}
