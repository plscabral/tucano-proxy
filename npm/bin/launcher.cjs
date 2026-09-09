#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { constants } = require('node:os');
const path = require('node:path');
const platforms = require('../platforms.json');
const metadata = require('../package.json');

function selectPlatform() {
  const key = `${process.platform}-${process.arch}`;
  const platform = platforms[key];
  if (!platform) {
    const windowsArm = process.platform === 'win32' && process.arch === 'arm64';
    throw new Error(
      `No native npm package is available for ${key}. ` +
      (windowsArm
        ? 'On Windows with x64 emulation, install the x64 version of Node.js and reinstall tucano-proxy; otherwise build the native CLI from source.'
        : 'Use macOS arm64/x64, Linux glibc arm64/x64, or Windows x64, or build the native CLI from source: https://github.com/plscabral/tucano-proxy')
    );
  }
  if (platform.libc === 'glibc') {
    let report;
    try {
      report = process.report.getReport();
    } catch {
      throw new Error('Cannot identify the Linux C library. Use an official glibc-based Node.js distribution and reinstall tucano-proxy, or build the native CLI from source.');
    }
    const glibc = report.header.glibcVersionRuntime;
    if (!glibc) {
      throw new Error(
        `This package requires Linux glibc >= ${platform.minimumGlibc}; musl/Alpine and unidentifiable C libraries are unsupported. ` +
        'Use a glibc-based distribution/container or build the native CLI from source. No binary will be downloaded at runtime.'
      );
    }
    const actual = /^(\d+)\.(\d+)(?:\.|$)/.exec(glibc);
    const [major, minor] = platform.minimumGlibc.split('.').map(Number);
    if (!actual || Number(actual[1]) < major || (Number(actual[1]) === major && Number(actual[2]) < minor)) {
      throw new Error(
        `Linux ${process.arch} requires glibc >= ${platform.minimumGlibc}; detected ${glibc}. ` +
        'Upgrade your distribution, use a supported glibc container, or build the native CLI from source.'
      );
    }
  }
  return platform;
}

function launch() {
  const platform = selectPlatform();
  let manifest;
  let installed;
  try {
    manifest = require.resolve(`${platform.name}/package.json`);
    installed = require(manifest);
  } catch (error) {
    throw new Error(
      `Cannot load ${platform.name}@${metadata.version} (${error.code || error.message}). ` +
      'Reinstall tucano-proxy with optional dependencies enabled (npm install --global --include=optional tucano-proxy). ' +
      'For a project-local install, omit --global. Do not copy node_modules across operating systems or CPU architectures.'
    );
  }
  if (installed.version !== metadata.version || installed.name !== platform.name) {
    throw new Error(
      `Expected ${platform.name}@${metadata.version}, found ${installed.name}@${installed.version}. ` +
      'Reinstall tucano-proxy with optional dependencies enabled; launcher and native package versions must match.'
    );
  }
  const executable = path.join(path.dirname(manifest), 'bin', platform.executable);
  // A package published with a 0644 binary installs cleanly and then cannot be
  // spawned. Restore the bit in place when the file is ours to fix; a read-only
  // or foreign-owned installation still reaches the explicit error below.
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(executable, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(executable, (fs.statSync(executable).mode & 0o777) | 0o111);
      } catch {}
    }
  }
  // Pass the original descriptors through untouched. The native CLI exclusively
  // owns raw mode, input reads, alternate-screen entry and terminal restoration.
  // In particular, never create/resume a Node stdin stream or call setRawMode.
  const child = spawn(executable, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, TUCANO_INSTALL_CHANNEL: 'npm' },
    shell: false,
  });
  const handlers = new Map();
  const signals = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    const handler = () => {
      // Windows delivers Ctrl-C/Ctrl-Break to both console processes. Sending
      // child.kill there forcibly terminates it before its terminal guard runs.
      if (process.platform === 'win32' && (signal === 'SIGINT' || signal === 'SIGBREAK')) return;
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
  child.once('error', (error) => {
    cleanup();
    console.error(
      `tucano-proxy: Cannot execute ${executable}: ${error.message}. ` +
      (process.platform === 'linux' && error.code === 'ENOENT'
        ? 'The native executable or glibc loader is missing. Use a supported glibc distribution and reinstall with optional dependencies enabled.'
        : 'Reinstall tucano-proxy with optional dependencies enabled and check executable permissions and platform compatibility.')
    );
    process.exitCode = error.code === 'ENOENT' ? 127 : 126;
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (!signal) {
      process.exitCode = code === null ? 1 : code;
      return;
    }
    process.exitCode = 128 + (constants.signals[signal] || 1);
    // Preserve signal termination on POSIX, including the shell's exit status.
    // Windows has no equivalent POSIX self-signal; retain the numeric status.
    if (process.platform !== 'win32') {
      try {
        process.kill(process.pid, signal);
      } catch {
        // The numeric status above is also useful if self-signalling is denied.
      }
    }
  });
}

if (require.main === module) {
  try {
    launch();
  } catch (error) {
    console.error(`tucano-proxy: ${error.message}`);
    process.exitCode = 1;
  }
}
