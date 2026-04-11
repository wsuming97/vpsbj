/*
 * LibreSpeed Worker (精简版)
 * 负责在 Web Worker 线程中执行下载/上传/Ping 测速
 * 与 speedtest_core.js 配合使用
 */

let testState = -1; // -1=未开始, 0=准备, 1=下载, 2=ping, 3=上传, 4=完成, 5=中止
let dlStatus = '', ulStatus = '', pingStatus = '', jitterStatus = '', clientIp = '';
let dlProgress = 0, ulProgress = 0, pingProgress = 0;
let settings = {};

self.addEventListener('message', function(e) {
  const params = e.data.split(' ');
  if (params[0] === 'status') {
    self.postMessage(JSON.stringify({
      testState, dlStatus, ulStatus, pingStatus, jitterStatus, clientIp,
      dlProgress, ulProgress, pingProgress
    }));
  } else if (params[0] === 'start') {
    settings = JSON.parse(e.data.substring(6));
    runTest();
  } else if (params[0] === 'abort') {
    testState = 5;
    try { if (dlXhr) dlXhr.abort(); } catch(e) {}
    try { if (ulXhr) ulXhr.abort(); } catch(e) {}
  }
});

let dlXhr, ulXhr;

function runTest() {
  testState = 0;

  // 默认参数
  const url_dl = settings.url_dl || '/speedtest/garbage';
  const url_ul = settings.url_ul || '/speedtest/empty';
  const url_ping = settings.url_ping || '/speedtest/empty';
  const url_getIp = settings.url_getIp || '/speedtest/getIP';
  const time_dl = settings.time_dl_max || 15;
  const time_ul = settings.time_ul_max || 15;
  const count_ping = settings.count_ping || 20;

  // 获取 IP
  getIP(url_getIp, function() {
    // 下载测速
    testState = 1;
    dlTest(url_dl, time_dl, function() {
      // Ping 测试
      testState = 2;
      pingTest(url_ping, count_ping, function() {
        // 上传测速
        testState = 3;
        ulTest(url_ul, time_ul, function() {
          testState = 4;
        });
      });
    });
  });
}

function getIP(url, cb) {
  let xhr = new XMLHttpRequest();
  xhr.open('GET', url + '?r=' + Math.random(), true);
  xhr.onload = function() {
    clientIp = xhr.responseText;
    cb();
  };
  xhr.onerror = function() { clientIp = '未知'; cb(); };
  xhr.send();
}

function dlTest(url, maxTime, cb) {
  let startTime = Date.now();
  let totalLoaded = 0;
  let ckSize = 25; // MB 块大小

  function doDownload() {
    if (testState === 5) return;
    let elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxTime) {
      dlProgress = 1;
      cb();
      return;
    }
    dlProgress = elapsed / maxTime;

    dlXhr = new XMLHttpRequest();
    dlXhr.open('GET', url + '?ckSize=' + ckSize + '&r=' + Math.random(), true);
    dlXhr.responseType = 'arraybuffer';
    dlXhr.onprogress = function(e) {
      if (testState === 5) { dlXhr.abort(); return; }
      totalLoaded += e.loaded;
      let elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        let speed = (totalLoaded * 8) / elapsed / 1000000; // Mbps
        dlStatus = speed.toFixed(2);
      }
      dlProgress = Math.min(elapsed / maxTime, 1);
      totalLoaded = 0;
    };
    dlXhr.onload = function() {
      totalLoaded += dlXhr.response.byteLength;
      let elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        let speed = (totalLoaded * 8) / elapsed / 1000000;
        dlStatus = speed.toFixed(2);
      }
      doDownload();
    };
    dlXhr.onerror = function() {
      dlStatus = '错误';
      cb();
    };
    dlXhr.send();
  }
  doDownload();
}

function pingTest(url, count, cb) {
  let pings = [];
  let i = 0;

  function doPing() {
    if (testState === 5 || i >= count) {
      pingProgress = 1;
      cb();
      return;
    }
    pingProgress = i / count;

    let t = Date.now();
    let xhr = new XMLHttpRequest();
    xhr.open('GET', url + '?r=' + Math.random(), true);
    xhr.onload = function() {
      let rtt = Date.now() - t;
      pings.push(rtt);

      // 计算平均 ping
      let sum = pings.reduce((a, b) => a + b, 0);
      pingStatus = (sum / pings.length).toFixed(2);

      // 计算 jitter（相邻 ping 差值的平均值）
      if (pings.length > 1) {
        let jitters = [];
        for (let j = 1; j < pings.length; j++) jitters.push(Math.abs(pings[j] - pings[j-1]));
        jitterStatus = (jitters.reduce((a, b) => a + b, 0) / jitters.length).toFixed(2);
      }

      i++;
      setTimeout(doPing, 200);
    };
    xhr.onerror = function() { i++; setTimeout(doPing, 200); };
    xhr.timeout = 3000;
    xhr.ontimeout = xhr.onerror;
    xhr.send();
  }
  doPing();
}

function ulTest(url, maxTime, cb) {
  let startTime = Date.now();
  let totalSent = 0;
  // 预生成 1MB 的上传数据
  let blob = new Blob([new ArrayBuffer(1024 * 1024)]);

  function doUpload() {
    if (testState === 5) return;
    let elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxTime) {
      ulProgress = 1;
      cb();
      return;
    }
    ulProgress = elapsed / maxTime;

    ulXhr = new XMLHttpRequest();
    ulXhr.open('POST', url + '?r=' + Math.random(), true);
    ulXhr.upload.onprogress = function(e) {
      if (testState === 5) { ulXhr.abort(); return; }
      totalSent += e.loaded;
      let elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0) {
        let speed = (totalSent * 8) / elapsed / 1000000;
        ulStatus = speed.toFixed(2);
      }
      ulProgress = Math.min(elapsed / maxTime, 1);
      totalSent = 0;
    };
    ulXhr.onload = function() {
      doUpload();
    };
    ulXhr.onerror = function() {
      ulStatus = '错误';
      cb();
    };
    // 发送多个 chunk 保持持续上传
    let formData = new FormData();
    for (let i = 0; i < 20; i++) formData.append('data' + i, blob);
    ulXhr.send(formData);
  }
  doUpload();
}
