import assert from "node:assert/strict";
import { chromium } from "../../dist/service/node_modules/playwright-core/index.mjs";

const main = `<!doctype html><meta charset="utf-8"><title>美团远程登录测试</title>
<style>body{margin:0;font:16px sans-serif;background:#fff9e7;min-height:1100px}h1{margin:24px;font-size:20px}button{position:absolute;left:24px;top:60px;width:120px;height:40px}iframe{position:absolute;top:110px;left:0;width:480px;height:440px;border:0;display:block}</style>
<h1>官方页面测试</h1><button id="open">登录</button><iframe id="login" src="/remote-test-login"></iframe>
<script>document.querySelector('#open').onclick=()=>document.querySelector('#login').style.display='block';
if(location.hostname==='offsiteact.meituan.com'){
window.H5guard={sign:async({url,method,data,headers})=>{if(url!=='/act/ge/queryPoiByRecallBiz'||method!=='POST'||'riskParams' in data||headers.mtgsig)throw new Error('Invalid signing request');return{headers:{mtgsig:'test-page-'+data.pageNo}}}};
fetch('/act/ge/getUserInfo',{method:'POST',headers:{'x-test-webdriver':String(navigator.webdriver)}});fetch('/act/ge/getPageModuleInfo');fetch('/act/ge/queryPoiByRecallBiz',{method:'POST',headers:{'Content-Type':'application/json',mtgsig:'test-page-1'},body:JSON.stringify({recallBizId:'cpsSelfPromotionOrder',pageNo:1,riskParams:{}})});}</script>`;
const login = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif;background:#fff}label{position:absolute;left:24px}input{position:absolute;left:24px;width:400px;height:36px;font-size:16px}button{position:absolute;left:24px;top:180px;width:400px;height:40px}#drag{position:absolute;left:24px;top:240px;width:40px;height:40px;background:#ce5038}#result{position:absolute;left:24px;top:300px}</style>
<label style="top:18px">测试手机号</label><input id="phone" style="top:45px"><button id="send" style="left:300px;top:45px;width:120px">获取验证码</button><label style="top:84px">测试验证码</label><input id="code" style="top:110px"><button id="submit">登录</button><div id="drag"></div><span id="result">拖动测试</span>
<script>let held=false;let start=0;document.querySelector('#drag').onmousedown=e=>{held=true;start=e.clientX};document.onmousemove=e=>{if(held)document.querySelector('#drag').style.left=Math.max(24,e.clientX-20)+'px'};document.onmouseup=e=>{if(held&&e.clientX-start>80)document.querySelector('#result').textContent='拖动完成';held=false};
document.querySelector('#send').onclick=()=>fetch('/api/v3/account/mobileloginapply',{method:'POST',body:'test-only'});
document.querySelector('#submit').onclick=async()=>{const p=document.querySelector('#phone').value,c=document.querySelector('#code').value;if(/^\\d{11}$/.test(p)&&c==='123456'&&document.querySelector('#result').textContent==='拖动完成'){await fetch('/api/v3/account/mobilelogin',{method:'POST',body:JSON.stringify({mobile:p,code:c})});await fetch('https://www.meituan.com/account/settoken',{method:'POST',body:'token=test-only-token'})}};</script>`;

const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  assert.equal(
    options.headless,
    true,
    "Remote login must never open a desktop window",
  );
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    let authenticatedPhone = "";
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        url.hostname === "passport.meituan.com" &&
        url.pathname === "/api/v3/account/mobileloginapply"
      )
        return route.fulfill({
          json: {
            error: {
              code: 123,
              message: "请求异常,拒绝操作",
              privateDetail: "private-refusal-canary",
            },
          },
        });
      if (
        url.hostname === "passport.meituan.com" &&
        url.pathname === "/account/unitivelogin"
      ) {
        assert.equal(route.request().method(), "GET");
        return route.fulfill({ contentType: "text/html", body: main });
      }
      if (
        url.hostname === "passport.meituan.com" &&
        url.pathname === "/api/v3/account/mobilelogin"
      ) {
        const request = JSON.parse(route.request().postData());
        authenticatedPhone = request.mobile;
        return route.fulfill({
          json: { user: { id: "111", token: "test-only-token" } },
        });
      }
      if (
        url.hostname === "www.meituan.com" &&
        url.pathname === "/account/settoken"
      ) {
        await context.addCookies([
          {
            name: "remote-test-phone",
            value: authenticatedPhone,
            domain: ".meituan.com",
            path: "/",
            secure: true,
          },
        ]);
        return route.fulfill({
          json: { ok: true },
          headers: {
            "Access-Control-Allow-Origin": "https://passport.meituan.com",
          },
        });
      }
      if (url.pathname === "/act/ge/getUserInfo") {
        const headers = await route.request().allHeaders();
        if (headers["x-test-webdriver"] !== "false" ||
          !/Android.*Chrome\/[\d.]+ Mobile/.test(headers["user-agent"] || ""))
          return route.fulfill({ status: 403, body: "private-unsupported-browser-canary" });
        const cookies = await context.cookies();
        const activitySession = cookies.find(cookie => cookie.name === "wm_ado_ge_x");
        if (activitySession) {
          assert.equal(cookies.some(cookie => cookie.name === "token"), false);
          assert.equal(cookies.find(cookie => cookie.name === "wm_ado_ge_e_k")?.value, "private-activity-key-canary");
          if (activitySession.value === "private-invalid-activity-canary")
            return route.fulfill({ json: { ret: 0, data: { phone: "" } } });
        }
        const phone =
          cookies.find(
            (cookie) => cookie.name === "remote-test-phone",
          )?.value || "";
        if (phone === "13900000000")
          return route.fulfill({
            status: 403,
            contentType: "text/html",
            body: "Forbidden",
          });
        return route.fulfill({ json: { ret: 0, data: { phone } } });
      }
      if (url.pathname === "/act/ge/getPageModuleInfo") {
        const phone =
          (await context.cookies()).find(
            (cookie) => cookie.name === "remote-test-phone",
          )?.value || "";
        return phone === "13900000000"
          ? route.fulfill({ status: 403, body: "Forbidden" })
          : route.fulfill({ json: { ret: 0 } });
      }
      if (url.pathname === "/act/ge/queryPoiByRecallBiz") {
        const phone = (await context.cookies()).find(cookie => cookie.name === "remote-test-phone")?.value;
        if (phone === "13600000000" || phone === "13500000000") {
          const request = JSON.parse(route.request().postData());
          assert.equal(request.recallBizId, "cpsSelfPromotionOrder");
          assert.equal((await route.request().allHeaders()).mtgsig, `test-page-${request.pageNo}`);
          assert.deepEqual(request.riskParams, {});
          if (phone === "13500000000" && request.pageNo === 2)
            return route.fulfill({ status: 403, contentType: "text/html", body: "private-pagination-refusal-canary" });
          const make = (id, distance) => ({ poi_id_str: id, poiBaseInfo: { name: `分页测试${id}（同一分店）`, distance },
            planActivityInfoList: [{ poiEventId: id, userMaxRatio: 3500, userMaxCommission: 1500,
              unifyToUserCommentRatio: 500, unifyToUserCommentCommission: 100, validInventory: 5 }] });
          const infos = request.pageNo === 1 ? [make("near", "1.0km")]
            : request.pageNo === 2 ? [make("near", "1.0km"), make("edge", "7.0km"), make("far", "7.1km")] : [];
          return route.fulfill({ json: { ret: 0, infos } });
        }
        return route.fulfill({ json: { ret: 0, infos: [] } });
      }
      if (url.pathname === "/remote-test-login")
        return route.fulfill({ contentType: "text/html", body: login });
      if (url.pathname.endsWith("/index.html"))
        return route.fulfill({ contentType: "text/html", body: main });
      return route.fulfill({ status: 204, body: "" });
    });
    return context;
  };
  return browser;
};
