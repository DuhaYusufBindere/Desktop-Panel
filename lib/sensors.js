// Donanım sensörleri: ağ hızı, GPU (nvidia-smi / Windows sayaçları / LibreHardwareMonitor), çalan medya.
const { spawn, execFile } = require('child_process');
const http = require('http');

const WIN = process.platform === 'win32';
const children = new Set();
process.on('exit', () => children.forEach(c => { try { c.kill(); } catch {} }));

// Kalıcı bir PowerShell döngüsü açar; her stdout satırı bir JSON nesnesidir.
function psLoop(script, onLine, withInput) {
  let fails = 0, stopped = false, child;
  const start = () => {
    if (stopped) return;
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: [withInput ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
    if (withInput) child.stdin.on('error', () => {});
    children.add(child);
    const t0 = Date.now();
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (l) { try { onLine(JSON.parse(l)); fails = 0; } catch {} }
      }
    });
    child.on('exit', () => {
      children.delete(child);
      if (Date.now() - t0 < 5000) fails++;
      if (!stopped && fails < 4) setTimeout(start, 3000);
    });
  };
  start();
  return { stop() { stopped = true; try { child.kill(); } catch {} }, send(line) { if (child && child.stdin && !child.stdin.destroyed) { child.stdin.write(line + String.fromCharCode(10)); return true; } return false; } };
}

const PS_HEAD = `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;
function Emit($o){ try{ [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() } catch { exit } }
`;

// ---------- ağ hızı (netstat -e, dil bağımsız) ----------
function netWatcher(cb) {
  if (!WIN) return;
  let last = null;
  setInterval(() => {
    execFile('netstat', ['-e'], { windowsHide: true, timeout: 3000 }, (err, out) => {
      if (err) return;
      const m = out.split(/\r?\n/).map(l => l.match(/^\s*\S+\s+(\d{3,})\s+(\d{3,})\s*$/)).find(Boolean);
      if (!m) return;
      const now = Date.now(), rx = +m[1], tx = +m[2];
      if (last && now > last.t) {
        const dt = (now - last.t) / 1000;
        cb({ down: Math.max(0, (rx - last.rx) / dt), up: Math.max(0, (tx - last.tx) / dt) });
      }
      last = { t: now, rx, tx };
    });
  }, 1000);
}

// ---------- GPU ----------
function gpuWatcher(cb, lhmUrl) {
  const state = { load: null, temp: null, vram: null, name: null, fan: null, cpuTemp: null, cpuPower: null, source: null };
  const push = () => cb({ ...state });

  // 1) Windows sayaçları (her üretici, ek yazılım gerekmez) — yük
  if (WIN) {
    psLoop(PS_HEAD + `while($true){
      $e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
      $v = ($e | Where-Object { $_.Name -like '*engtype_3D*' } | Measure-Object UtilizationPercentage -Sum).Sum
      $m = ($e | Measure-Object UtilizationPercentage -Maximum).Maximum
      $mem = (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Measure-Object DedicatedUsage -Sum).Sum
      Emit @{ load = $(if($v -ne $null){[math]::Min(100,[math]::Round($v,1))}else{$null}); vram = $mem }
      Start-Sleep 2 }`, o => {
      if (state.source !== 'nvidia' && state.source !== 'lhm') { state.load = o.load; state.source = 'wmi'; }
      if (state.vram == null || state.source === 'wmi') state.vram = o.vram;
      push();
    });
  }

  // 2) nvidia-smi — yük, sıcaklık, bellek, fan
  if (WIN) execFile('where', ['nvidia-smi'], { windowsHide: true }, err => {
    if (err) return;
    setInterval(() => {
      execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,fan.speed', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 3000 }, (e, out) => {
        if (e) return;
        const p = out.trim().split('\n')[0].split(',').map(s => s.trim());
        if (p.length < 4) return;
        state.name = p[0]; state.load = +p[1]; state.temp = +p[2]; state.vram = +p[3] * 1048576;
        if (!isNaN(+p[4])) state.fanPct = +p[4];
        state.source = 'nvidia'; push();
      });
    }, 2000);
  });

  // 3) LibreHardwareMonitor uzak web sunucusu — CPU sıcaklığı, fan, güç, AMD/Intel GPU sıcaklığı
  let wait = 2000;
  const poll = () => {
    const req = http.get(lhmUrl, { timeout: 1500 }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', d => body += d);
      res.on('end', () => {
        try { applyLHM(JSON.parse(body), state); state.lhm = true; push(); wait = 2000; } catch { wait = 10000; }
        setTimeout(poll, wait);
      });
    });
    req.on('error', () => { state.lhm = false; wait = 10000; setTimeout(poll, wait); });
    req.on('timeout', () => req.destroy());
  };
  poll();
}

function applyLHM(root, st) {
  const num = v => { const n = parseFloat(String(v || '').replace(',', '.')); return isNaN(n) ? null : n; };
  const cpuT = [], gpuT = [], fans = [];
  let gpuLoad = null, cpuPower = null, gpuName = null;
  (function walk(n, hw, grp) {
    const img = (n.ImageURL || '').toLowerCase(), txt = n.Text || '';
    if (/cpu\.png/.test(img)) hw = 'cpu';
    else if (/nvidia|ati\.png|amd|gpu|intel/.test(img) && n.Children && n.Children.length && !/temperature|load|clock|power|fan|data|voltage|control|throughput/.test(img)) { hw = 'gpu'; gpuName = gpuName || txt; }
    if (/temperature/.test(img)) grp = 'temp'; else if (/load/.test(img)) grp = 'load'; else if (/fan/.test(img)) grp = 'fan'; else if (/power/.test(img)) grp = 'power';
    const kids = n.Children || [];
    if (!kids.length && n.Value) {
      const v = num(n.Value);
      if (v != null) {
        if (hw === 'cpu' && grp === 'temp') cpuT.push([txt, v]);
        if (hw === 'cpu' && grp === 'power' && /package/i.test(txt)) cpuPower = v;
        if (hw === 'gpu' && grp === 'temp') gpuT.push([txt, v]);
        if (hw === 'gpu' && grp === 'load' && /gpu core|d3d 3d/i.test(txt) && gpuLoad == null) gpuLoad = v;
        if (grp === 'fan' && v > 0) fans.push(v);
      }
    }
    kids.forEach(k => walk(k, hw, grp));
  })(root, null, null);
  const pick = (arr, re) => { const m = arr.find(a => re.test(a[0])); return m ? m[1] : arr.length ? Math.max(...arr.map(a => a[1])) : null; };
  const ct = pick(cpuT, /package|tctl|tdie/i), gt = pick(gpuT, /gpu core|hot spot|^gpu$/i);
  if (ct != null) st.cpuTemp = ct;
  if (cpuPower != null) st.cpuPower = cpuPower;
  if (gt != null && st.source !== 'nvidia') st.temp = gt;
  if (gpuLoad != null && st.source !== 'nvidia') { st.load = gpuLoad; st.source = 'lhm'; }
  if (gpuName && !st.name) st.name = gpuName;
  if (fans.length) st.fan = Math.max(...fans);
}

// ---------- çalan medya (Windows SMTC) ----------
function mediaWatcher(cb) {
  if (!WIN) return;
  const script = PS_HEAD + `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op,$type){ $t=$asTask.MakeGenericMethod($type).Invoke($null,@($op)); [void]$t.Wait(-1); $t.Result }
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$lastKey = ''
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte s,uint f,int e);' -Name K -Namespace W
$in = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$pending = $in.ReadLineAsync()
$vk = @{ volup=0xAF; voldown=0xAE; mute=0xAD; playpause=0xB3; next=0xB0; prev=0xB1 }
function Run-Cmd($c){
  $s = $mgr.GetCurrentSession()
  $ok = $false
  if($s){
    switch($c){
      'playpause' { $ok = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
      'next'      { $ok = Await ($s.TrySkipNextAsync()) ([bool]) }
      'prev'      { $ok = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    }
  }
  if(-not $ok -and $vk.ContainsKey($c)){ [W.K]::keybd_event($vk[$c],0,0,0); [W.K]::keybd_event($vk[$c],0,2,0) }
}
while($true){
  $s = $mgr.GetCurrentSession()
  if($s){
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $pb = $s.GetPlaybackInfo(); $tl = $s.GetTimelineProperties()
    $key = "$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
    $thumb = $null
    if($key -ne $lastKey){
      $lastKey = $key
      try{
        if($p.Thumbnail){
          $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
          $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($st)
          $ms = New-Object IO.MemoryStream; $net.CopyTo($ms)
          if($ms.Length -gt 0 -and $ms.Length -lt 900000){ $thumb = 'data:' + $st.ContentType + ';base64,' + [Convert]::ToBase64String($ms.ToArray()) }
        }
      }catch{}
      Emit @{ key=$key; thumb=$thumb; newTrack=$true; title=$p.Title; artist=$p.Artist; album=$p.AlbumTitle; status=$pb.PlaybackStatus.ToString(); app=$s.SourceAppUserModelId; pos=$tl.Position.TotalSeconds; dur=$tl.EndTime.TotalSeconds }
    } else {
      Emit @{ key=$key; newTrack=$false; title=$p.Title; artist=$p.Artist; album=$p.AlbumTitle; status=$pb.PlaybackStatus.ToString(); app=$s.SourceAppUserModelId; pos=$tl.Position.TotalSeconds; dur=$tl.EndTime.TotalSeconds }
    }
  } else { $lastKey=''; Emit @{ none=$true } }
  # 1 sn bekle ama bu arada gelen komutu hemen uygula
  for($i=0; $i -lt 20; $i++){
    if($pending.IsCompleted){
      $line = $pending.Result
      if($line -eq $null){ exit }
      Run-Cmd $line.Trim()
      $pending = $in.ReadLineAsync()
      Start-Sleep -Milliseconds 250   # uygulamanın durumu güncellemesine izin ver
      break
    }
    Start-Sleep -Milliseconds 50
  }
}`;
  return psLoop(script, cb, true);
}

module.exports = { netWatcher, gpuWatcher, mediaWatcher };
