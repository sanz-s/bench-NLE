// Fixture tests for the bench-server's OS parsers:  node --test bench-server/
// macOS fixtures are real output captured on an M3 Pro; Linux/Windows fixtures follow the documented formats.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as P from './probes.mjs'

const proc = (pid, ppid, exe, cmd = '') => ({ pid, ppid, exe, cmd, cpu: 0, rssKB: 1000 })

test('ps comm table keeps executable names with spaces', () => {
  const t = P.parsePsComm(
    [
      '  501     1   1:02.50 812000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '  777   501   0:10.00 300000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
      '  900     1 1-02:03:04.56  1200 /usr/libexec/searchpartyd',
    ].join('\n'),
  )
  assert.deepEqual(
    t.map((p) => p.exe),
    ['Google Chrome', 'Google Chrome Helper (Renderer)', 'searchpartyd'],
  )
  assert.equal(t[0].cpu, 62.5)
  assert.equal(t[2].cpu, 86400 + 2 * 3600 + 3 * 60 + 4.56)
})

test('browser executable whitelist: browsers yes, look-alikes no', () => {
  for (const yes of ['Google Chrome', 'Google Chrome Helper (Aperitif Renderer)', 'Google Chrome for Testing', 'chrome-headless-shell', 'Ulaa Helper (Renderer)', 'firefox', 'plugin-container', 'com.apple.WebKit.WebContent', 'msedge.exe', 'chrome'])
    assert.ok(P.isBrowserExe(yes), yes)
  for (const no of ['Spotify Helper (Renderer)', 'searchpartyd', 'searchpartyuseragent', 'CsFalconConnector', 'Code Helper (Renderer)', 'Cliq Helper', 'chrome_crashpad_handler', 'node'])
    assert.ok(!P.isBrowserExe(no), no)
})

test('name match: browser trees only; native hosts, crashpad and the sampler’s own children are dropped', () => {
  const procs = [
    proc(1, 0, 'launchd'),
    proc(10, 1, 'Google Chrome'),
    proc(11, 10, 'Google Chrome Helper (Renderer)', '--type=renderer'),
    proc(12, 10, 'Google Chrome Helper (GPU)', '--type=gpu-process'),
    proc(13, 10, 'CsFalconConnector', 'CsFalconConnector chrome-extension://abc/'),
    proc(14, 10, 'chrome_crashpad_handler'),
    proc(20, 1, 'Spotify'),
    proc(21, 20, 'Spotify Helper (Renderer)', '--type=renderer'),
    proc(30, 1, 'searchpartyd'),
    proc(40, 1, 'Ulaa'),
    proc(41, 40, 'Ulaa Helper'),
    proc(99, 1, 'node'),
    proc(100, 99, 'ps'),
  ]
  const { selected, mode } = P.selectBrowserProcs(procs, { platform: 'darwin', selfPid: 99 })
  assert.equal(mode, 'name-match')
  assert.deepEqual(selected.map((p) => p.pid).sort((a, b) => a - b), [10, 11, 12, 40, 41])
})

test('tree mode keeps a trusted root whatever its binary is called', () => {
  const procs = [proc(1, 0, 'launchd'), proc(50, 1, 'weird-browser-build'), proc(51, 50, 'weird-browser-build'), proc(52, 50, 'Google Chrome Helper')]
  const { selected, mode } = P.selectBrowserProcs(procs, { rootPid: 50, platform: 'darwin' })
  assert.equal(mode, 'tree')
  assert.deepEqual(selected.map((p) => p.pid).sort(), [50, 52])
})

test('Safari: a WebKit-service root selects Safari + all WebKit services', () => {
  const procs = [proc(1, 0, 'launchd'), proc(60, 1, 'Safari'), proc(61, 1, 'com.apple.WebKit.Networking'), proc(62, 1, 'com.apple.WebKit.WebContent'), proc(63, 1, 'com.apple.WebKit.GPU'), proc(64, 1, 'Mail')]
  const { selected, mode } = P.selectBrowserProcs(procs, { rootPid: 61, platform: 'darwin' })
  assert.equal(mode, 'safari-webkit')
  assert.deepEqual(selected.map((p) => p.pid).sort(), [60, 61, 62, 63])
})

test('Linux: renamed Firefox children are kept, extension hosts are not', () => {
  const procs = [proc(1, 0, 'systemd'), proc(70, 1, 'firefox'), proc(71, 70, 'Web Content'), proc(72, 70, 'RDD Process'), proc(73, 70, 'keepassxc-proxy', '/usr/bin/keepassxc-proxy /usr/lib/mozilla/native-messaging-hosts/x.json moz-extension://1/')]
  const { selected } = P.selectBrowserProcs(procs, { platform: 'linux' })
  assert.deepEqual(selected.map((p) => p.pid).sort(), [70, 71, 72])
})

test('browserRootOf walks up to the topmost browser process (Playwright Chrome has node as parent)', () => {
  const procs = [proc(1, 0, 'launchd'), proc(5, 1, 'node'), proc(6, 5, 'Google Chrome'), proc(7, 6, 'Google Chrome Helper', '--type=utility --utility-sub-type=network.mojom.NetworkService')]
  assert.equal(P.browserRootOf(procs, 7).pid, 6)
  assert.equal(P.browserRootOf(procs, 5), null)
})

test('/proc/<pid>/stat: comm with spaces and parentheses; utime+stime; rss pages', () => {
  // fields: pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime prio nice threads itreal start vsize rss
  const line = '4242 (Web Content (x)) S 4200 4200 4200 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 12345 1000000 2560 18446744073709551615'
  const st = P.parseProcStat(line, { clkTck: 100, pageSize: 4096 })
  assert.deepEqual(st, { pid: 4242, ppid: 4200, exe: 'Web Content (x)', cpu: 3, rssKB: 10240 })
  assert.equal(P.parseProcCmdline(Buffer.from('/usr/lib/firefox/firefox\0-contentproc\0')), '/usr/lib/firefox/firefox -contentproc')
})

test('smaps_rollup PSS', () => {
  assert.equal(P.parseSmapsRollupPss('55d0-7ffc ---p 00000000 00:00 0  [rollup]\nRss:              204800 kB\nPss:              150123 kB\nPss_Anon:          90000 kB\n'), 150123)
  assert.equal(P.parseSmapsRollupPss('nothing'), null)
})

test('top MEM sizes and streaming blocks', () => {
  assert.equal(P.parseTopSize('413M+'), 413)
  assert.equal(P.parseTopSize('12K'), 12 / 1024)
  assert.equal(P.parseTopSize('1.5G-'), 1536)
  assert.equal(P.parseTopSize('512B'), 512 / 1048576)
  const text = 'Processes: 700 total\nLoad Avg: 2.1\n\nPID    MEM \n50894  383M \n50895  31M+\n\nProcesses: 701 total\nPID    MEM \n50894  390M \n508'
  const blocks = P.parseTopBlocks(text)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].get(50894), 383)
  assert.equal(blocks[0].get(50895), 31)
})

test('ioreg: real M3 Pro output, and the busiest of several GPUs', () => {
  const real = '"PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=3806134272,"Tiler Utilization %"=4,"recoveryCount"=0,"lastRecoveryTime"=0,"Renderer Utilization %"=3,"TiledSceneBytes"=917504,"Device Utilization %"=4,"SplitSceneCount"=0}'
  assert.deepEqual(P.parseIoregGpu(real), { device: 4, renderer: 3, tiler: 4, encoder: null, decoder: null, gpus: 1 })
  const two = '"Device Utilization %"=5,"Renderer Utilization %"=5,"Tiler Utilization %"=1 ... "Device Utilization %"=71,"Renderer Utilization %"=60,"Tiler Utilization %"=20'
  assert.deepEqual(P.parseIoregGpu(two), { device: 71, renderer: 60, tiler: 20, encoder: null, decoder: null, gpus: 2 })
})

test('nvidia-smi: several GPUs, encoder/decoder, power, [N/A] fields', () => {
  const n = P.parseNvidiaSmi('12, 40, 3, 55.20\n80, [N/A], 0, [N/A]\n')
  assert.deepEqual(n, { device: 80, renderer: null, tiler: null, encoder: 40, decoder: 3, powerW: 55.2, gpus: 2 })
})

test('Windows GPU engine counters (lower-case instance names) → per engine and per browser pid', () => {
  const s = [
    { c: 'utilization percentage', n: 'pid_1200_luid_0x00000000_0x0000d1e8_phys_0_eng_0_engtype_3d', v: 30 },
    { c: 'utilization percentage', n: 'pid_1200_luid_0x00000000_0x0000d1e8_phys_0_eng_4_engtype_videoencode', v: 45 },
    { c: 'utilization percentage', n: 'pid_800_luid_0x00000000_0x0000d1e8_phys_0_eng_0_engtype_3d', v: 20 },
    { c: 'utilization percentage', n: 'pid_900_luid_0x00000000_0x0000d1e8_phys_0_eng_3_engtype_videodecode', v: 10 },
  ]
  const g = P.summarizeGpuEngines(s, new Set([1200]))
  assert.equal(g.renderer, 50)
  assert.equal(g.encoder, 45)
  assert.equal(g.decoder, 10)
  assert.equal(g.device, 50)
  assert.equal(g.browser3d, 30)
  assert.equal(g.browserEncoder, 45)
  const m = P.summarizeGpuProcessMemory(
    [
      { c: 'dedicated usage', n: 'pid_1200_luid_0x0_0xd1e8_phys_0', v: 104857600 },
      { c: 'shared usage', n: 'pid_1200_luid_0x0_0xd1e8_phys_0', v: 52428800 },
      { c: 'dedicated usage', n: 'pid_800_luid_0x0_0xd1e8_phys_0', v: 999999999 },
    ],
    new Set([1200]),
  )
  assert.deepEqual(m, { dedicatedMB: 100, sharedMB: 50 })
})

test('lsof -F owners: peer port (exact socket) and page port, IPv4 + IPv6; self excluded', () => {
  const out = ['p300', 'n127.0.0.1:5181->127.0.0.1:63880', 'p72039', 'n127.0.0.1:63880->127.0.0.1:5181', 'p4000', 'n[::1]:51000->[::1]:5181', 'p999', 'n127.0.0.1:63880->127.0.0.1:5181'].join('\n')
  assert.deepEqual([...P.parseLsofOwners(out, { peerPort: 63880, selfPid: 999 })], [72039])
  assert.deepEqual([...P.parseLsofOwners(out, { pagePort: 5181, selfPid: 999 })].sort(), [4000, 72039])
})

test('/proc/net/tcp: established sockets by local or remote port', () => {
  const t = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:143D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:F948 0100007F:143D 01 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 20 4 30 10 -1',
    '   2: 0100007F:143D 0100007F:F948 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 20 4 30 10 -1',
  ].join('\n')
  assert.deepEqual([...P.parseProcNetTcp(t, { peerPort: 0xf948 })], ['22222'])
  assert.deepEqual([...P.parseProcNetTcp(t, { pagePort: 0x143d })], ['22222'])
})

test('pmset: real outputs from this Mac', () => {
  assert.deepEqual(P.parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=36438115)\t100%; charged; 0:00 remaining present: true"), { source: 'ac', batteryPct: 100 })
  assert.deepEqual(P.parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t64%; discharging; 3:10 remaining present: true"), { source: 'battery', batteryPct: 64 })
  assert.equal(P.parsePmsetLowPower(' lowpowermode         0\n'), false)
  assert.deepEqual(P.parsePmsetTherm('Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded'), {
    thermalWarning: 'none',
    performanceWarning: 'none',
    cpuSpeedLimitPct: null,
  })
  assert.equal(P.parsePmsetTherm('CPU_Scheduler_Limit \t= 100\nCPU_Available_CPUs \t= 8\nCPU_Speed_Limit \t= 70').cpuSpeedLimitPct, 70)
})

test('powermetrics text lines', () => {
  assert.deepEqual(P.parsePowermetricsLine('GPU Power: 3215 mW'), { gpuW: 3.215 })
  assert.deepEqual(P.parsePowermetricsLine('CPU Power: 812 mW'), { cpuW: 0.812 })
  assert.deepEqual(P.parsePowermetricsLine('GPU HW active frequency: 1398 MHz'), { gpuMHz: 1398 })
  // real M3 Pro lines (macOS 26B131)
  assert.deepEqual(P.parsePowermetricsLine('E-Cluster HW active frequency: 1754 MHz'), { cluster: 'E', mhz: 1754 })
  assert.deepEqual(P.parsePowermetricsLine('E-Cluster HW active residency:  70.52% (744 MHz:  17% 1044 MHz: 1.7%)'), { cluster: 'E', activePct: 70.52 })
  assert.deepEqual(P.parsePowermetricsLine('P-Cluster HW active residency:   9.47% (696 MHz: .32% 1092 MHz:   0%)'), { cluster: 'P', activePct: 9.47 })
  assert.deepEqual(P.parsePowermetricsLine('P1-Cluster HW active frequency: 3204 MHz'), { cluster: 'P1', mhz: 3204 })
  assert.deepEqual(P.parsePowermetricsLine('GPU HW active residency:   3.58% (338 MHz: 2.1% 618 MHz: .14%)'), { gpuActive: 3.58 })
  assert.equal(P.parsePowermetricsLine('CPU 6 frequency: 1508 MHz'), null)
  assert.equal(P.parsePowermetricsLine('E-Cluster idle residency:  29.48%'), null)
})

test('Chrome process types', () => {
  assert.equal(P.procType('/x/Google Chrome'), 'browser')
  assert.equal(P.procType('--type=renderer --foo'), 'renderer')
  assert.equal(P.procType('--type=utility --utility-sub-type=network.mojom.NetworkService'), 'utility-network')
  assert.equal(P.procType('--type=utility --utility-sub-type=media.mojom.VideoEncodeAcceleratorProviderFactory'), 'utility-media')
})

test('procstat helper lines (real output format)', () => {
  const t = P.parseProcstat('50879\t1\t264905080041\t341854920\t429801472\t/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n83307\t83240\t1672250\t81992\t32768\t/usr/bin/awk\nEND\n')
  assert.equal(t.length, 2)
  assert.equal(t[0].exe, 'Google Chrome')
  assert.equal(t[0].ppid, 1)
  assert.ok(Math.abs(t[0].cpu - 264.905080041) < 1e-9)
  assert.ok(Math.abs(t[0].footprintMB - 326.01) < 0.01)
  assert.equal(t[0].rssKB, 419728)
})

test('VideoToolbox services are recognised as media services, not browsers', () => {
  assert.ok(P.isMediaService('VTEncoderXPCService'))
  assert.ok(P.isMediaService('VTDecoderXPCService'))
  assert.ok(!P.isMediaService('Google Chrome'))
  assert.ok(!P.isBrowserExe('VTEncoderXPCService'))
})

test('Firefox child roles map onto the Chrome-style process types', () => {
  const base = '/Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -isForBrowser -prefsLen 31000 -prefMapSize 244000 -appDir /Applications/Firefox.app/Contents/Resources/browser 85267 gecko-crash-server-pipe.85267 org.mozilla.machname.1'
  assert.equal(P.procType(`${base} tab`), 'renderer')
  assert.equal(P.procType(`${base} gpu`), 'gpu-process')
  assert.equal(P.procType(`${base} rdd`), 'utility-media')
  assert.equal(P.procType(`${base} socket`), 'utility-network')
  assert.equal(P.procType('/Applications/Firefox.app/Contents/MacOS/firefox --headless'), 'browser')
})

test('powermetrics tasks rows (real M3 Pro format; names cut to 32 chars and containing spaces)', () => {
  const hdr = 'Name                               ID     CPU ms/s  User%  Deadlines (<2 ms, 2-5 ms)  Wakeups (Intr, Pkg idle)  GPU ms/s'
  assert.equal(P.parsePowermetricsTaskRow(hdr), null)
  assert.deepEqual(P.parsePowermetricsTaskRow('Google Chrome Helper (Aperitif R   65301  47.44     75.27  1.86    3.73               26.09   0.00              0.00      '), {
    pid: 65301,
    name: 'Google Chrome Helper (Aperitif R',
    cpuMsPerS: 47.44,
    gpuMsPerS: 0,
  })
  assert.deepEqual(P.parsePowermetricsTaskRow('VTEncoderXPCService                86629  16.76     49.51  0.00    0.00               0.00    0.00              12.50     '), {
    pid: 86629,
    name: 'VTEncoderXPCService',
    cpuMsPerS: 16.76,
    gpuMsPerS: 12.5,
  })
  assert.equal(P.parsePowermetricsTaskRow('ALL_TASKS                          -2     1509.09   54.24  659.98  143.89             2294.59 111.28            0.00      ').pid, -2)
  assert.equal(P.parsePowermetricsTaskRow('**** Processor usage ****'), null)
})
