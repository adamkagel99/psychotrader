import React, { useState, useEffect, useRef } from "react";

const STORAGE_KEY = "tf-state";
const SETTINGS_KEY = "tf-settings";
const GOALS_KEY = "tf-goals";
const EVENTS_KEY = "tf-events";
const EVENT_FILTERS_KEY = "tf-event-filters";
const TRANSFERS_KEY = "tf-transfers";
const CHECKLIST_KEY = "tf-checklist-items";
const DISCIPLINE_SCORING_KEY = "tf-discipline-scoring";

function loadTransfers(){
  try{
    var s=localStorage.getItem(TRANSFERS_KEY);if(!s)return[];
    var p=JSON.parse(s);if(!Array.isArray(p))return[];
    // CHANGED: The old "flip every amount" migration was removed — it was a one-time fix that
    // re-fired and corrupted user data whenever localStorage was cleared (Clear Data, import, etc).
    // Convention is now permanent: deposits = positive amount, withdrawals = negative.
    return p;
  }catch(e){return[];}
}
function saveTransfers(t){try{localStorage.setItem(TRANSFERS_KEY,JSON.stringify(t));}catch(e){}}
function transferTotal(transfers){
  if(!transfers||!transfers.length)return 0;
  var today=getPT();today.setHours(0,0,0,0);
  var tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
  return transfers.reduce(function(s,t){var d=new Date(t.date);if(isNaN(d.getTime()))return s;if(d>=tomorrow)return s;return s+(parseFloat(t.amount)||0);},0);
}
function loadEvents(){try{var s=localStorage.getItem(EVENTS_KEY);if(!s)return[];var p=JSON.parse(s);return Array.isArray(p)?p:(p.events||[]);}catch(e){return[];}}
function loadEventsWeekStart(){try{var s=localStorage.getItem(EVENTS_KEY);if(!s)return null;var p=JSON.parse(s);return Array.isArray(p)?null:(p.weekStart||null);}catch(e){return null;}}
function getWeekStartStr(){var now=getPT();var dow=now.getDay();var s=new Date(now.getFullYear(),now.getMonth(),now.getDate()-dow);s.setHours(0,0,0,0);return s.toLocaleDateString("en-US");}
function saveEventsWithMeta(events){var wrapper={weekStart:getWeekStartStr(),importedAt:new Date().toISOString(),events:events};localStorage.setItem(EVENTS_KEY,JSON.stringify(wrapper));try{localStorage.removeItem(EVENT_FILTERS_KEY);}catch(e){}}
function maybeClearStaleEvents(){var ws=loadEventsWeekStart();if(ws&&ws!==getWeekStartStr()){try{localStorage.removeItem(EVENTS_KEY);}catch(e){}try{localStorage.removeItem(EVENT_FILTERS_KEY);}catch(e){}return true;}return false;}
function parseEventDate(e){if(!e||!e.date)return null;var d=new Date(e.date+(e.time?" "+e.time:""));return isNaN(d.getTime())?null:d;}
// CHANGED: Detect currency from various common field names (country, Currency, code, etc.)
function eventCurrency(e){
  if(!e)return "";
  var raw=e.currency||e.Currency||e.country||e.Country||e.code||e.Code||e.cur||e.fxCode||e.country_code||e.countryCode||"";
  if(!raw)return "";
  raw=String(raw).trim().toUpperCase();
  // Map common country names/codes to FX codes
  var map={"UNITED STATES":"USD","US":"USD","USA":"USD","UNITED KINGDOM":"GBP","UK":"GBP","GB":"GBP","EUROZONE":"EUR","EURO ZONE":"EUR","EU":"EUR","EUROPEAN UNION":"EUR","JAPAN":"JPY","JP":"JPY","CANADA":"CAD","CA":"CAD","AUSTRALIA":"AUD","AU":"AUD","NEW ZEALAND":"NZD","NZ":"NZD","SWITZERLAND":"CHF","CH":"CHF","CHINA":"CNY","CN":"CNY"};
  return map[raw]||raw;
}
// CHANGED: shared impact normalizer + event-filter loader so the Journal can warn about imminent events.
function normalizeImpact(imp){var lvl=(imp||"").toLowerCase();if(lvl==="high"||lvl==="red")return "high";if(lvl==="medium"||lvl==="med"||lvl==="orange")return "medium";if(lvl==="low"||lvl==="yellow")return "low";if(lvl==="holiday"||lvl==="non-economic")return "holiday";return "none";}
function loadEventFilters(){try{var s=localStorage.getItem(EVENT_FILTERS_KEY);if(s){var p=JSON.parse(s);return {currency:Array.isArray(p.currency)?p.currency:[],impact:Array.isArray(p.impact)?p.impact:[]};}}catch(e){}return {currency:[],impact:[]};}
// Returns events matching the user's saved filters that start within [now, now+windowMin], soonest first.
function getImminentEvents(windowMin){
  windowMin=windowMin||60;
  var f=loadEventFilters();
  var now=getPT();
  var horizon=new Date(now.getTime()+windowMin*60000);
  return loadEvents().map(function(e){return Object.assign({},e,{_d:parseEventDate(e)});}).filter(function(e){
    if(!e._d)return false;
    if(e._d<now||e._d>horizon)return false;
    var imp=normalizeImpact(e.impact);
    if(imp==="none"||imp==="holiday")return false; // only economic impact levels warn
    if(f.currency.length>0&&f.currency.indexOf(eventCurrency(e))<0)return false;
    if(f.impact.length>0&&f.impact.indexOf(imp)<0)return false;
    return true;
  }).sort(function(a,b){return a._d-b._d;});
}

// CHANGED: Today's events under the user's currency/impact filters — used by the session banner in Journal.
function getTodaysFilteredEvents(){return getFilteredEventsForDate(getPT());}
// CHANGED: Filtered events for any specific calendar date. Used both by the live session banner
// (today) and by the journal write so each journal day can store the events that were relevant
// that day at the time it was saved.
function getFilteredEventsForDate(d){
  if(!d)return [];
  var f=loadEventFilters();
  var dayStart=new Date(d.getFullYear(),d.getMonth(),d.getDate());dayStart.setHours(0,0,0,0);
  var dayEnd=new Date(dayStart.getTime()+24*60*60*1000);
  return loadEvents().map(function(e){return Object.assign({},e,{_d:parseEventDate(e)});}).filter(function(e){
    if(!e._d)return false;
    if(e._d<dayStart||e._d>=dayEnd)return false;
    var imp=normalizeImpact(e.impact);
    if(imp==="none"||imp==="holiday")return false;
    if(f.currency.length>0&&f.currency.indexOf(eventCurrency(e))<0)return false;
    if(f.impact.length>0&&f.impact.indexOf(imp)<0)return false;
    return true;
  }).sort(function(a,b){return a._d-b._d;});
}
// CHANGED: Strip the live Date object before persisting an event onto a journal entry — the raw
// timestamp/date/currency/title/impact suffices for replay and is safely JSON-serializable.
function eventToStorable(e){
  if(!e)return null;
  var t=null;try{t=(e._d&&e._d.getTime)?e._d.getTime():(parseEventDate(e)||new Date()).getTime();}catch(_){t=Date.now();}
  return {ts:t,title:e.title||e.name||"",impact:normalizeImpact(e.impact),currency:eventCurrency(e),date:e.date||null,time:e.time||null};
}

var USER_TIMEZONE=(function(){try{var s=localStorage.getItem("tf-tz");return s||"America/Los_Angeles";}catch(e){return "America/Los_Angeles";}})();
function setUserTimezone(tz){USER_TIMEZONE=tz;try{localStorage.setItem("tf-tz",tz);}catch(e){}}
var TIMEZONES=[
  {value:"America/New_York",label:"Eastern (ET)",offset:0},
  {value:"America/Chicago",label:"Central (CT)",offset:-1},
  {value:"America/Denver",label:"Mountain (MT)",offset:-2},
  {value:"America/Phoenix",label:"Arizona (MST)",offset:-2},
  {value:"America/Los_Angeles",label:"Pacific (PT)",offset:-3},
  {value:"America/Anchorage",label:"Alaska (AKT)",offset:-4},
  {value:"Pacific/Honolulu",label:"Hawaii (HT)",offset:-5}
];
function getNow(){
  // CHANGED: some JS runtimes lack full timezone (ICU) data and throw on valid zones.
  // Fall back to local time instead of crashing the whole app.
  try{return new Date(new Date().toLocaleString("en-US",{timeZone:USER_TIMEZONE}));}
  catch(e){return new Date();}
}
function getPT(){return getNow();}
function fmtTime(d){var h=d.getHours(),m=d.getMinutes().toString().padStart(2,"0");return (h%12||12)+":"+m+" "+(h>=12?"PM":"AM");}

var DAYS_OF_WEEK=[{n:0,short:"Sun",long:"Sunday"},{n:1,short:"Mon",long:"Monday"},{n:2,short:"Tue",long:"Tuesday"},{n:3,short:"Wed",long:"Wednesday"},{n:4,short:"Thu",long:"Thursday"},{n:5,short:"Fri",long:"Friday"},{n:6,short:"Sat",long:"Saturday"}];

// CHANGED: All default session colors are now green so the dashboard visual feels consistent.
var LEGACY_SESSIONS=[
  {id:"preMarket",label:"Pre-Market",etStart:240,etEnd:585,color:"#22c55e",defaultEnabled:false,sizeFraction:1,maxTrades:99,notes:""},
  {id:"opening",label:"Opening",etStart:585,etEnd:690,color:"#22c55e",defaultEnabled:true,sizeFraction:1,maxTrades:99,notes:""},
  {id:"midDay",label:"Mid-Day Lull",etStart:690,etEnd:810,color:"#22c55e",defaultEnabled:false,sizeFraction:0.5,maxTrades:2,notes:""},
  {id:"afternoon",label:"Afternoon",etStart:810,etEnd:940,color:"#22c55e",defaultEnabled:true,sizeFraction:0.5,maxTrades:2,notes:""},
  {id:"closing",label:"Closing",etStart:940,etEnd:960,color:"#22c55e",defaultEnabled:true,sizeFraction:1,maxTrades:99,notes:""},
  {id:"afterHours",label:"After-Hours",etStart:960,etEnd:1200,color:"#22c55e",defaultEnabled:false,sizeFraction:1,maxTrades:99,notes:""}
];
var SESSIONS=LEGACY_SESSIONS.slice();

function etMinsToTzMins(etMins,tz){var refDate=new Date();var etOffset=getTZOffsetMinutes("America/New_York",refDate);var tzOffset=getTZOffsetMinutes(tz,refDate);var local=etMins+(tzOffset-etOffset);while(local<0)local+=1440;while(local>=1440)local-=1440;return local;}
function defaultSessionsForTz(tz){
  return LEGACY_SESSIONS.map(function(s){
    return {
      id:s.id,name:s.label,
      startMin:etMinsToTzMins(s.etStart,tz),endMin:etMinsToTzMins(s.etEnd,tz),
      enabled:s.defaultEnabled,sizeFraction:s.sizeFraction,maxTrades:s.maxTrades,
      notes:s.notes,color:s.color,
      days:[1,2,3,4,5]
    };
  });
}
function getSessions(settings){
  if(settings&&Array.isArray(settings.sessions)&&settings.sessions.length>0){
    // Migrate sessions without days field, and normalize all colors to green.
    return settings.sessions.map(function(s){
      var out=s;
      if(!out.days||!Array.isArray(out.days))out=Object.assign({},out,{days:[1,2,3,4,5]});
      // CHANGED: Force all session colors to green for visual consistency.
      if(out.color!=="#22c55e")out=Object.assign({},out,{color:"#22c55e"});
      return out;
    });
  }
  return defaultSessionsForTz((settings&&settings.timezone)||USER_TIMEZONE||"America/Los_Angeles");
}

function getCurrentMinutesET(){try{var et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));return et.getHours()*60+et.getMinutes();}catch(e){var n=new Date();return n.getHours()*60+n.getMinutes();}}
function getCurrentMinutesLocal(){var n=getNow();return n.getHours()*60+n.getMinutes();}
function fmtMinutes(m){m=((m%1440)+1440)%1440;var h=Math.floor(m/60),mm=m%60;return (h%12||12)+":"+(mm<10?"0"+mm:mm)+" "+(h>=12?"PM":"AM");}
// CHANGED: Helpers for <input type="time"> which uses 24-hour HH:MM strings.
function minsToTimeStr(m){m=((m%1440)+1440)%1440;var h=Math.floor(m/60),mm=m%60;return (h<10?"0"+h:h)+":"+(mm<10?"0"+mm:mm);}
function timeStrToMins(s){if(!s||typeof s!=="string")return 0;var p=s.split(":");if(p.length<2)return 0;var h=parseInt(p[0])||0,mm=parseInt(p[1])||0;return h*60+mm;}
// CHANGED: Helpers for leg timestamps. Each leg stores ms since epoch; the input shows HH:MM (24h).
function tsToTimeStr(ts){if(!ts)return "";var d=new Date(ts);var h=d.getHours(),mm=d.getMinutes();return (h<10?"0"+h:h)+":"+(mm<10?"0"+mm:mm);}
function applyTimeStrToTs(ts,s){var base=ts?new Date(ts):new Date();var p=(s||"").split(":");var h=parseInt(p[0])||0,mm=parseInt(p[1])||0;base.setHours(h,mm,0,0);return base.getTime();}
function getTradingWindows(settings){if(settings&&Array.isArray(settings.tradingWindows)&&settings.tradingWindows.length>0)return settings.tradingWindows;var s=settings&&settings.tradingStartMin!=null?settings.tradingStartMin:60;var e=settings&&settings.tradingEndMin!=null?settings.tradingEndMin:1020;return [{start:s,end:e}];}
function isWithinTradingWindow(localMins,settings){var ws=getTradingWindows(settings);for(var i=0;i<ws.length;i++){var w=ws[i];if(localMins>=w.start&&localMins<w.end)return true;}return false;}

var CACHED_SESSIONS=[];
// CHANGED: Parse "h:mm AM/PM" or "HH:mm" (24h) into minutes-of-day. Returns null if unparseable.
function parseTimeToMinsOfDay(str){
  if(!str||typeof str!=="string")return null;
  var m=str.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if(!m)return null;
  var h=parseInt(m[1],10);var mm=parseInt(m[2],10);
  if(isNaN(h)||isNaN(mm))return null;
  var ap=(m[3]||"").toUpperCase();
  if(ap==="PM"&&h<12)h+=12;
  else if(ap==="AM"&&h===12)h=0;
  return h*60+mm;
}
// CHANGED: Compute time-in-trade for a single trade in milliseconds. Uses the timestamps stored
// on each entry/exit leg (already numeric ms). Falls back to openedAt/closedAt or to parsing
// entryTime/exitTime strings against the trade's date if leg-level timestamps aren't present.
function tradeDurationMs(t){
  if(!t||t.status==="open")return 0;
  var ents=t.entries||[],exs=t.exits||[];
  var entryT=ents.map(function(e){return Number(e.time);}).filter(function(n){return !isNaN(n)&&n>0;});
  var exitT=exs.map(function(e){return Number(e.time);}).filter(function(n){return !isNaN(n)&&n>0;});
  if(entryT.length>0&&exitT.length>0){
    var first=Math.min.apply(null,entryT);
    var last=Math.max.apply(null,exitT);
    if(last>first)return last-first;
  }
  // Fallback: openedAt/closedAt numeric timestamps.
  var op=Number(t.openedAt),cl=Number(t.closedAt);
  if(!isNaN(op)&&!isNaN(cl)&&cl>op)return cl-op;
  // Fallback: parse entryTime/exitTime strings against the trade's date.
  var em=parseTimeToMinsOfDay(t.entryTime||t.time);
  var xm=parseTimeToMinsOfDay(t.exitTime);
  if(em!=null&&xm!=null&&xm>em)return (xm-em)*60*1000;
  return 0;
}
// CHANGED: Format a duration in ms as "Hh Mm" / "Mm" / "Ss" — used by the Performance "Time Trading" tile.
function fmtDurationMs(ms){
  if(!ms||ms<=0)return "0m";
  var s=Math.round(ms/1000);
  if(s<60)return s+"s";
  var m=Math.round(s/60);
  if(m<60)return m+"m";
  var h=Math.floor(m/60),rm=m%60;
  return rm>0?(h+"h "+rm+"m"):(h+"h");
}
// CHANGED: Derive sessionId from a trade's actual start time (first entry time, falling back to t.time, then openedAt).
// Day-of-week comes from openedAt so a back-entered trade gets the right weekday.
function getSessionForTrade(t){
  if(!t)return null;
  var timeStr=(t.entries&&t.entries[0]&&t.entries[0].time)||t.time||null;
  var mins=parseTimeToMinsOfDay(timeStr);
  var date=null;
  if(t.openedAt){try{date=new Date(t.openedAt);}catch(e){}}
  if(mins==null&&date){mins=date.getHours()*60+date.getMinutes();}
  if(mins==null)return null;
  var day=(date?date.getDay():getNow().getDay());
  // Pass 1: exact match — time falls inside a session window and the day is enabled for it.
  for(var i=0;i<CACHED_SESSIONS.length;i++){
    var s=CACHED_SESSIONS[i];
    if(s.enabled===false)continue;
    if(mins<s.startMin||mins>=s.endMin)continue;
    var days=s.days||[1,2,3,4,5];
    if(days.indexOf(day)<0)continue;
    return s.id;
  }
  // CHANGED: Pass 2 — nearest enabled session by time distance. Ensures trades placed off-hours
  // (after market close, before pre-market, etc.) still get attributed to a session so they show
  // up in session breakdowns and the Session×Day heatmap.
  var best=null,bestDist=Infinity;
  for(var j=0;j<CACHED_SESSIONS.length;j++){
    var s2=CACHED_SESSIONS[j];
    if(s2.enabled===false)continue;
    var d2=s2.days||[1,2,3,4,5];
    if(d2.indexOf(day)<0)continue;
    var dist;
    if(mins<s2.startMin)dist=s2.startMin-mins;
    else if(mins>=s2.endMin)dist=mins-s2.endMin;
    else dist=0;
    if(dist<bestDist){bestDist=dist;best=s2.id;}
  }
  return best;
}
function getSessionAt(minutesLocal){
  var dayOfWeek=getNow().getDay();
  for(var i=0;i<CACHED_SESSIONS.length;i++){
    var s=CACHED_SESSIONS[i];
    if(s.enabled===false) continue;
    if(minutesLocal<s.startMin||minutesLocal>=s.endMin) continue;
    var days=s.days||[1,2,3,4,5];
    if(days.indexOf(dayOfWeek)<0) continue;
    return s.id;
  }
  return null;
}
function getPhase(){
  var now=getNow();var day=now.getDay();
  if(day===0||day===6)return "closed";
  var dateKey=todayStr();
  if(MARKET_HOLIDAYS[dateKey])return "closed";
  var localMins=getCurrentMinutesLocal();
  var s=getSessionAt(localMins);
  return s||"closed";
}
// CHANGED: The pre-market checklist is only shown from 15 minutes before the first enabled
// session of the day until the last enabled session ends. Hidden outside that window.
function isChecklistWindowOpen(settings){
  var now=getNow();var day=now.getDay();
  if(day===0||day===6)return false;
  if(MARKET_HOLIDAYS[todayStr()])return false;
  var sessions=getSessions(settings).filter(function(s){
    if(s.enabled===false)return false;
    var days=s.days||[1,2,3,4,5];
    return days.indexOf(day)>=0;
  });
  if(!sessions.length)return false;
  var earliestStart=Math.min.apply(null,sessions.map(function(s){return s.startMin;}));
  var latestEnd=Math.max.apply(null,sessions.map(function(s){return s.endMin;}));
  var mins=getCurrentMinutesLocal();
  return mins>=(earliestStart-15)&&mins<latestEnd;
}
function getSessionByID(id){var found=CACHED_SESSIONS.filter(function(s){return s.id===id;})[0];if(found)return found;var leg=LEGACY_SESSIONS.filter(function(s){return s.id===id;})[0];return leg||null;}
function formatSessionTimeRange(s){
  if(!s)return "";
  if(s.startMin!=null&&s.endMin!=null)return fmtMinutes(s.startMin)+" – "+fmtMinutes(s.endMin);
  function fmt(etMins){var refDate=new Date();var etOffset=getTZOffsetMinutes("America/New_York",refDate);var userOffset=getTZOffsetMinutes(USER_TIMEZONE,refDate);var localMins=etMins+(userOffset-etOffset);while(localMins<0)localMins+=1440;while(localMins>=1440)localMins-=1440;return fmtMinutes(localMins);}
  return fmt(s.etStart)+" – "+fmt(s.etEnd);
}
function getTZOffsetMinutes(tz,date){try{var d=date||new Date();var utc=new Date(d.toLocaleString("en-US",{timeZone:"UTC"}));var tzd=new Date(d.toLocaleString("en-US",{timeZone:tz}));return Math.round((tzd-utc)/60000);}catch(e){return 0;}}
function getPhaseLabel(phase){
  var dateKey=todayStr();
  if(phase==="closed"){if(MARKET_HOLIDAYS[dateKey])return "Market Closed · "+MARKET_HOLIDAYS[dateKey];var day=getNow().getDay();if(day===0||day===6)return "Market Closed · Weekend";return "No Active Session";}
  var s=getSessionByID(phase);if(!s)return "Unknown Session";
  var name=s.name||s.label||phase;
  return name+" ("+formatSessionTimeRange(s)+")";
}
function todayStr(){return getNow().toLocaleDateString("en-US");}
function todayDisplay(){return getNow().toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"});}
function secToMin(sec){var min=Math.floor(sec/60),fmtMin=min.toString().padStart(2,"0"),s=sec%60,fmtSec=s.toString().padStart(2,"0");return fmtMin+":"+fmtSec;}
function fmtDuration(ms){var sec=Math.max(0,Math.round(ms/1000));if(sec<60)return sec+"s";var min=Math.floor(sec/60),s=sec%60;if(min<60)return s>0?min+"m "+s+"s":min+"m";var hr=Math.floor(min/60),m=min%60;return m>0?hr+"h "+m+"m":hr+"h";}
function compressImage(file,maxWidth,quality){
  if(maxWidth==null)maxWidth=1280;if(quality==null)quality=0.7;
  return new Promise(function(resolve,reject){
    var reader=new FileReader();
    reader.onload=function(ev){var img=new Image();img.onload=function(){var w=img.width,h=img.height;var ratio=Math.min(1,maxWidth/w);var cw=Math.round(w*ratio),ch=Math.round(h*ratio);var canvas=document.createElement("canvas");canvas.width=cw;canvas.height=ch;var ctx=canvas.getContext("2d");ctx.fillStyle="#000";ctx.fillRect(0,0,cw,ch);ctx.drawImage(img,0,0,cw,ch);try{resolve(canvas.toDataURL("image/jpeg",quality));}catch(e){reject(e);}};img.onerror=function(){reject(new Error("Failed to load image"));};img.src=ev.target.result;};
    reader.onerror=function(){reject(new Error("Failed to read file"));};
    reader.readAsDataURL(file);
  });
}

var PHASE_LABELS={preMarket:"Pre-Market",opening:"Opening",midDay:"Mid-Day Lull",afternoon:"Afternoon",closing:"Closing",afterHours:"After-Hours",closed:"Market Closed"};
var PHASE_COLORS={preMarket:"#6366f1",opening:"#ef4444",midDay:"#f59e0b",afternoon:"#10b981",closing:"#22c55e",afterHours:"#8b5cf6",closed:"#374151"};
var CANDLE_PATTERNS=["Hammer Bar Break","Inside Bar Break","Bullish Flag","Bearish Flag","Head and Shoulders"];
var SETUP_TYPES=["Breakout","Fakeout","Trend Cont.","Reversion","VWAP","ORB"];
// CHANGED: Default indicator list — common technical indicators traders flag on entry.
var INDICATORS=["VWAP","EMA 9","EMA 20","EMA 50","SMA 200","RSI","MACD","Bollinger Bands","Volume","Support/Resistance","Trendline","Fibonacci"];
// CHANGED: "Max risk exceeded" and "Oversized entry" are AUTO-ONLY — applied solely by their rules,
// never manually selectable. ALL_VIOLATIONS is the full set (used for filtering/display); VIOLATIONS
// is the manually-selectable subset shown in the trade form and Settings options editor.
var AUTO_VIOLATIONS=["Max risk exceeded","Oversized entry"];
var ALL_VIOLATIONS=["Entry without confirmation","Oversized entry","Max risk exceeded"];
var VIOLATIONS=ALL_VIOLATIONS.filter(function(x){return AUTO_VIOLATIONS.indexOf(x)<0;});
var TIMEFRAMES=["1m","2m","5m","10m","15m","30m","1h","4h","1D"];
// CHANGED: Convert a timeframe string (e.g. "5m", "1h", "1D", "1W") to minutes for sorting.
function timeframeToMinutes(tf){
  if(!tf||typeof tf!=="string")return 0;
  var m=tf.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if(!m)return 0;
  var n=parseFloat(m[1])||0;
  var unit=m[2].toLowerCase();
  if(unit==="s"||unit==="sec")return n/60;
  if(unit==="m"||unit==="min")return n;
  if(unit==="h"||unit==="hr")return n*60;
  if(unit==="d"||unit==="day")return n*60*24;
  if(unit==="w"||unit==="wk"||unit==="week")return n*60*24*7;
  if(unit==="mo"||unit==="month")return n*60*24*30;
  return 0;
}
function sortTimeframes(arr){return (arr||[]).slice().sort(function(a,b){return timeframeToMinutes(a)-timeframeToMinutes(b);});}
var EMOTIONS=["Calm","Focused","FOMO","Revenge"];
var DEFAULT_EMOTION_SENTIMENTS={"Calm":"positive","Focused":"positive","FOMO":"negative","Revenge":"negative"};
var OPTIONS_KEY="tf-options";
function defaultOptions(){return {setup:SETUP_TYPES.slice(),timeframe:TIMEFRAMES.slice(),candlePattern:CANDLE_PATTERNS.slice(),indicator:INDICATORS.slice(),emotion:EMOTIONS.slice(),violation:VIOLATIONS.slice(),emotionSentiments:Object.assign({},DEFAULT_EMOTION_SENTIMENTS)};}
function loadOptions(){
  try{var s=localStorage.getItem(OPTIONS_KEY);if(!s)return defaultOptions();
    var p=JSON.parse(s);var d=defaultOptions();
    var sentiments=Object.assign({},DEFAULT_EMOTION_SENTIMENTS,p.emotionSentiments||{});
    (p.emotion||d.emotion).forEach(function(e){if(sentiments[e]==null)sentiments[e]="neutral";});
    // CHANGED: Strip auto-only violations (e.g. "Max risk exceeded") from saved manual options.
    var savedViol=(p.violation||d.violation).filter(function(x){return AUTO_VIOLATIONS.indexOf(x)<0;});
    return {setup:p.setup||d.setup,timeframe:sortTimeframes(p.timeframe||d.timeframe),candlePattern:p.candlePattern||d.candlePattern,indicator:p.indicator||d.indicator,emotion:p.emotion||d.emotion,violation:savedViol,emotionSentiments:sentiments};
  }catch(e){return defaultOptions();}
}
function saveOptions(opts){try{localStorage.setItem(OPTIONS_KEY,JSON.stringify(opts));}catch(e){}}
function getEmotionSentiment(name,sentiments){var s=(sentiments||{})[name];return s||DEFAULT_EMOTION_SENTIMENTS[name]||"neutral";}
function isNegEmotion(name,sentiments){return getEmotionSentiment(name,sentiments)==="negative";}
function isPosEmotion(name,sentiments){return getEmotionSentiment(name,sentiments)==="positive";}
function getStoredSentiments(){try{var s=localStorage.getItem(OPTIONS_KEY);if(s){var p=JSON.parse(s);return p.emotionSentiments||DEFAULT_EMOTION_SENTIMENTS;}}catch(e){}return DEFAULT_EMOTION_SENTIMENTS;}
function emotionTagColor(name,sentiments){var s=getEmotionSentiment(name,sentiments||getStoredSentiments());return s==="positive"?"#22c55e":s==="negative"?"#ef4444":"#94a3b8";}
var NEG_EMOTIONS=["FOMO","Revenge"];
var REMOVED_EMOTIONS=["Anxious","Overconfident"];
function filterEmotions(emotions){return (emotions||[]).filter(function(e){return REMOVED_EMOTIONS.indexOf(e)<0;});}
var MONTH_NAMES=["January","February","March","April","May","June","July","August","September","October","November","December"];

var MARKET_HOLIDAYS={
  "1/1/2025":"New Year's Day","1/20/2025":"MLK Day","2/17/2025":"Presidents' Day","4/18/2025":"Good Friday","5/26/2025":"Memorial Day","6/19/2025":"Juneteenth","7/4/2025":"Independence Day","9/1/2025":"Labor Day","11/27/2025":"Thanksgiving","12/25/2025":"Christmas",
  "1/1/2026":"New Year's Day","1/19/2026":"MLK Day","2/16/2026":"Presidents' Day","4/3/2026":"Good Friday","5/25/2026":"Memorial Day","6/19/2026":"Juneteenth","7/3/2026":"Independence Day (observed)","9/7/2026":"Labor Day","11/26/2026":"Thanksgiving","12/25/2026":"Christmas",
  "1/1/2027":"New Year's Day","1/18/2027":"MLK Day","2/15/2027":"Presidents' Day","3/26/2027":"Good Friday","5/31/2027":"Memorial Day","6/18/2027":"Juneteenth (observed)","7/5/2027":"Independence Day (observed)","9/6/2027":"Labor Day","11/25/2027":"Thanksgiving","12/24/2027":"Christmas (observed)",
  "1/17/2028":"MLK Day","2/21/2028":"Presidents' Day","4/14/2028":"Good Friday","5/29/2028":"Memorial Day","6/19/2028":"Juneteenth","7/4/2028":"Independence Day","9/4/2028":"Labor Day","11/23/2028":"Thanksgiving","12/25/2028":"Christmas"
};
var EARLY_CLOSE_DAYS={
  "7/3/2025":"Day before Independence Day","11/28/2025":"Day after Thanksgiving","12/24/2025":"Christmas Eve",
  "11/27/2026":"Day after Thanksgiving","12/24/2026":"Christmas Eve",
  "11/26/2027":"Day after Thanksgiving",
  "7/3/2028":"Day before Independence Day","11/24/2028":"Day after Thanksgiving"
};

// CHANGED: Sizing base steps by $1k up to $15k, then by $5k beyond — so above $15k the position
// and risk hold steady across each $5k band and only step up at the next $5k tier (with the same
// 5% buffer as the lower ramp). This protects the user from sizing up too soon as the account grows.
function getBase(a){
  var b=500,n=1;
  // $1k increments until the base reaches $15k.
  while(n*1000<=15000&&a>n*1000*1.05){b=n*1000;n++;}
  if(b>=15000){
    // $5k increments from $15k upward.
    var k=15000;
    while(a>(k+5000)*1.05){k+=5000;}
    b=k;
  }
  return b;
}
// CHANGED: positionMin and riskMin are now derived from slippagePct (% below max).
// CHANGED: Risk Max % is now a percentage of Position Max (not the account balance).
// CHANGED: Also supports fixed-dollar sizing mode (positionMaxDollar, riskMaxDollar).
function calcPosSizes(a,pcts){
  // CHANGED: When useDirect=true (milestone preview), use 'a' as the base directly instead of getBase(a).
  var b=(pcts&&pcts.useDirect)?a:getBase(a);
  var p=pcts||{slippagePct:20,positionMaxPct:7.5,riskMaxPct:33};
  var slip=p.slippagePct!=null?p.slippagePct:20;
  var posMax,riskMax;
  if(p.sizingMode==="dollar"){
    posMax=Math.round(parseFloat(p.positionMaxDollar)||0);
    riskMax=Math.round(parseFloat(p.riskMaxDollar)||0);
  }else{
    var posMaxPct=p.positionMaxPct!=null?p.positionMaxPct:7.5;
    var riskMaxPct=p.riskMaxPct!=null?p.riskMaxPct:33;
    posMax=Math.round(b*(posMaxPct/100));
    riskMax=Math.round(posMax*(riskMaxPct/100));
  }
  var posMin=Math.round(posMax*(1-slip/100));
  var riskMin=Math.round(riskMax*(1-slip/100));
  return {base:b,positionMin:posMin,positionMax:posMax,riskMin:riskMin,riskMax:riskMax};
}
function discColor(score){return score>=80?"#22c55e":score>=60?"#f59e0b":"#ef4444";}
function wrColor(rate){return rate>=60?"#22c55e":rate>=40?"#f59e0b":"#ef4444";}

// CHANGED: Discipline scoring is now configurable via settings.
// rOutcomeWeight: points awarded per +1R of clean (violation-free) day P&L.
// rOutcomeCap: hard ceiling/floor on the R term (±) so outcome can NUDGE but never DOMINATE process.
// rOutcomeCleanOnly: when true, the positive R bonus is suppressed on days with any violation —
//   a lucky win does not get to paper over rule-breaking. Losing-R always counts (small penalty).
var DEFAULT_DISCIPLINE_SCORING={violationPenalty:15,negEmotionPenalty:10,posEmotionBonus:3,aGradeBonus:5,cGradePenalty:5,rOutcomeWeight:2,rOutcomeCap:10,rOutcomeCleanOnly:true,overTradePenalty:10,setupDeviationPenalty:10};
// CHANGED: Discipline lock threshold — editable, persisted. If a day's score falls below this, trading locks.
var DISCIPLINE_LOCK_KEY="tf-discipline-lock-threshold";
function loadDisciplineLockThreshold(){try{var s=localStorage.getItem(DISCIPLINE_LOCK_KEY);if(s!=null){var v=parseFloat(s);if(!isNaN(v))return v;}}catch(e){}return 60;}
function saveDisciplineLockThreshold(v){try{localStorage.setItem(DISCIPLINE_LOCK_KEY,String(v));}catch(e){}}
var DISCIPLINE_LOCK_ACK_KEY="tf-discipline-lock-ack";
// CHANGED: Lock is NOT user-removable. Cooldown = one full day served. It auto-clears once 2+
// calendar days have passed since the trigger day. This naturally lets weekends/holidays serve
// the cooldown: bad Wed -> locked Thu, free Fri; bad Fri -> the weekend serves it, free Mon.
function daysBetween(aStr,bStr){
  var a=new Date(aStr);a.setHours(0,0,0,0);
  var b=new Date(bStr);b.setHours(0,0,0,0);
  return Math.round((b.getTime()-a.getTime())/86400000);
}
function checkDisciplineLock(todayTrades,commitment){
  try{
    var threshold=loadDisciplineLockThreshold();
    // 1) Same-day: today's live trades drop below threshold -> locked today (no unlock).
    var tToday=(todayTrades||[]).filter(function(t){return t.status!=="open";});
    if(tToday.length>0){
      // CHANGED: Include commitment penalties so the lock score matches journal/performance.
      var todayScore=calcDiscipline(tToday,0,{processOnly:true,commitment:commitment||null});
      if(todayScore<threshold){
        return {locked:true,fromDate:todayStr(),score:Math.round(todayScore),sameDay:true};
      }
    }
    // 2) A recent completed trading day was below threshold.
    var rows=loadJournalRows().filter(function(r){return (r.trades||[]).length>0;});
    if(rows.length===0)return {locked:false};
    rows.sort(function(a,b){return (new Date(a.date).getTime()||0)-(new Date(b.date).getTime()||0);});
    var todayD=new Date(todayStr());todayD.setHours(0,0,0,0);
    var prior=null;
    rows.forEach(function(r){var d=new Date(r.date);d.setHours(0,0,0,0);if(d.getTime()<todayD.getTime())prior=r;});
    if(!prior)return {locked:false};
    // CHANGED: A lock is an immutable historical event. If the prior day was marked wasLocked when
    // it happened, honor that even if a later discipline recompute (different commitment context,
    // settings change, etc.) would now score it above threshold. This prevents the lock from
    // silently disappearing after a recompute.
    var liveScore=(prior.trades&&prior.trades.length>0)
      ? calcDiscipline(prior.trades,0,{processOnly:true,commitment:prior.commitment||null})
      : (prior.disciplineScore!=null?parseFloat(prior.disciplineScore):100);
    var wasLocked=!!prior.wasLocked;
    var score=wasLocked?(prior.lockScore!=null?parseFloat(prior.lockScore):liveScore):liveScore;
    if(!wasLocked&&liveScore>=threshold)return {locked:false};
    // Auto-clear once 2+ calendar days have passed (one full day served as cooldown).
    var elapsed=daysBetween(prior.date,todayStr());
    if(elapsed>=2)return {locked:false,expired:true,fromDate:prior.date,score:Math.round(score)};
    return {locked:true,fromDate:prior.date,score:Math.round(score),clearsIn:Math.max(0,2-elapsed)};
  }catch(e){return {locked:false};}
}
function loadDisciplineScoring(){try{var s=localStorage.getItem(DISCIPLINE_SCORING_KEY);if(s)return Object.assign({},DEFAULT_DISCIPLINE_SCORING,JSON.parse(s));}catch(e){}return Object.assign({},DEFAULT_DISCIPLINE_SCORING);}
function saveDisciplineScoring(ds){try{localStorage.setItem(DISCIPLINE_SCORING_KEY,JSON.stringify(ds));}catch(e){}}

function calcDiscipline(trades,riskMaxArg,opts){
  var sentiments=null;
  try{var s=localStorage.getItem(OPTIONS_KEY);if(s){var p=JSON.parse(s);sentiments=p.emotionSentiments||DEFAULT_EMOTION_SENTIMENTS;}}catch(e){sentiments=DEFAULT_EMOTION_SENTIMENTS;}
  if(!sentiments)sentiments=DEFAULT_EMOTION_SENTIMENTS;
  var ds=loadDisciplineScoring();
  var posMax=0;
  var riskMaxPctSetting=33;
  try{var st=localStorage.getItem(SETTINGS_KEY);if(st){var sp=JSON.parse(st);posMax=parseFloat(sp.positionMax)||0;if(sp.riskMaxPct!=null)riskMaxPctSetting=parseFloat(sp.riskMaxPct)||0;}}catch(e){}
  // CHANGED: riskMax for the R-outcome term. Prefer the explicit arg (so historical journal
  // rows can pass their own saved riskMax); fall back to current settings for live callers.
  var riskMax=parseFloat(riskMaxArg)||0;
  if(riskMax<=0){try{var st2=localStorage.getItem(SETTINGS_KEY);if(st2){var sp2=JSON.parse(st2);riskMax=parseFloat(sp2.riskMax)||0;}}catch(e){}}
  // --- Process spine (unchanged): the part the lock must trust ---
  var processScore=100;
  var anyViolation=false;
  var dayPnL=0;
  trades.forEach(function(t){
    var vs=(t.violations||[]).slice();
    var pos=parseFloat(t.positionSize)||0;
    // CHANGED: Prefer the position max stamped on the trade at save time; fall back to current settings.
    var effPosMax=(parseFloat(t.posMaxAtEntry)>0)?parseFloat(t.posMaxAtEntry):posMax;
    // CHANGED: Symmetric add/remove — stale "Oversized entry" violations from before an edit get
    // dropped here too, not just by autoAddViolations. Same idea for "Max risk exceeded" below.
    var overIdx=vs.indexOf("Oversized entry");
    if(effPosMax>0&&pos>effPosMax){if(overIdx<0)vs.push("Oversized entry");}
    else if(overIdx>=0){vs.splice(overIdx,1);}
    // CHANGED: Recompute "Max risk exceeded" — loss % worse than session-scaled risk cap.
    // Prefer the threshold stamped at entry; else derive from current riskMaxPct × the trade's sizeFraction.
    var slPnl=parseFloat(t.pnl),slPct=parseFloat(t.pctPnl);
    var effStopThresh=(parseFloat(t.stopThreshPctAtEntry)>0)?parseFloat(t.stopThreshPctAtEntry):(riskMaxPctSetting>0?riskMaxPctSetting*((t.sizeFraction!=null&&!isNaN(parseFloat(t.sizeFraction)))?parseFloat(t.sizeFraction):1):0);
    var maxRiskIdx=vs.indexOf("Max risk exceeded");
    if(!isNaN(slPnl)&&slPnl<0&&!isNaN(slPct)&&effStopThresh>0&&slPct<-effStopThresh){if(maxRiskIdx<0)vs.push("Max risk exceeded");}
    else if(maxRiskIdx>=0){vs.splice(maxRiskIdx,1);}
    if(vs.length>0)anyViolation=true;
    processScore-=vs.length*(ds.violationPenalty||15);
    processScore-=(t.emotions||[]).filter(function(x){return getEmotionSentiment(x,sentiments)==="negative";}).length*(ds.negEmotionPenalty||10);
    if(t.grade==="A")processScore+=(ds.aGradeBonus||5);
    if(t.grade==="C")processScore-=(ds.cGradePenalty||5);
    processScore+=(t.emotions||[]).filter(function(x){return getEmotionSentiment(x,sentiments)==="positive";}).length*(ds.posEmotionBonus||3);
    dayPnL+=parseFloat(t.pnl)||0;
  });
  // CHANGED: Commitment adherence penalties. If a commitment was made for the day, exceeding the
  // committed trade cap and/or self-marking setup deviation each subtract from the process score and
  // count as a violation (so a winning-but-off-plan day forfeits the R bonus, like rule violations do).
  var com=opts&&opts.commitment;
  if(com&&com.committed){
    var maxT=parseInt(com.maxTrades);
    var closedN=trades.filter(function(t){return t&&t.status!=="open";}).length;
    if(!isNaN(maxT)&&maxT>0&&closedN>maxT){processScore-=(ds.overTradePenalty!=null?ds.overTradePenalty:10);anyViolation=true;}
    if(com.setupsReviewAffirmed===false){processScore-=(ds.setupDeviationPenalty!=null?ds.setupDeviationPenalty:10);anyViolation=true;}
  }
  processScore=Math.min(100,Math.max(0,processScore));
  // --- R-outcome term (secondary, bounded) ---
  // R = day P&L expressed in units of one trade's max risk. Bounded by ±rOutcomeCap so a huge
  // day cannot swamp the process signal. Positive R is suppressed on violation days when
  // rOutcomeCleanOnly is set — winning while breaking rules is not rewarded. Negative R always
  // applies (a losing day is a small process-independent ding, never a bonus).
  var rTerm=0;
  if(!(opts&&opts.processOnly)&&riskMax>0&&trades.length>0){
    var dayR=dayPnL/riskMax;
    var weight=ds.rOutcomeWeight!=null?ds.rOutcomeWeight:2;
    var cap=ds.rOutcomeCap!=null?ds.rOutcomeCap:10;
    var raw=dayR*weight;
    if(raw>0&&(ds.rOutcomeCleanOnly!==false)&&anyViolation)raw=0;
    rTerm=Math.max(-cap,Math.min(cap,raw));
  }
  var combined=processScore+rTerm;
  // CHANGED: Temporary diagnostic — log the score breakdown so we can see why repeated saves drift.
  try{if(typeof window!=="undefined"&&window.__disciplineDebug)console.log("[disc]",{trades:trades.length,processScore:processScore,rTerm:rTerm,anyViolation:anyViolation,dayPnL:dayPnL,combined:combined,perTrade:trades.map(function(t){return {id:t.id,grade:t.grade,violations:t.violations,emotions:t.emotions,pos:t.positionSize,posMaxAtEntry:t.posMaxAtEntry,pnl:t.pnl,pctPnl:t.pctPnl,sizeFraction:t.sizeFraction};})});}catch(e){}
  // CRITICAL CLAMP: the outcome term must never lift a failing process day above the lock
  // threshold. If process alone is below threshold, the R bonus cannot rescue it — at most it
  // brings the score up to (threshold - 1), so the lock still fires. Losing-R penalties are
  // allowed to push further down freely.
  if(rTerm>0){
    var thr=loadDisciplineLockThreshold();
    if(processScore<thr)combined=Math.min(combined,thr-1);
  }
  return Math.min(100,Math.max(0,combined));
}
function defaultSessionRules(){return {preMarket:{enabled:false,sizeFraction:1,maxTrades:99,notes:""},opening:{enabled:true,sizeFraction:1,maxTrades:99,notes:""},midDay:{enabled:false,sizeFraction:0.5,maxTrades:2,notes:""},afternoon:{enabled:true,sizeFraction:0.5,maxTrades:2,notes:""},closing:{enabled:true,sizeFraction:1,maxTrades:99,notes:""},afterHours:{enabled:false,sizeFraction:1,maxTrades:99,notes:""}};}
// CHANGED: Each asset class now has its own quantity and price labels for the trade entry/exit leg inputs.
var ASSET_CLASSES={
  options:{label:"Options",unit:"contracts",unitSingular:"contract",qtyLabel:"Contracts",qtyLabelSingular:"Contract",priceLabel:"Position Cost",directions:["CALL","PUT"],showStrike:true,showExpiry:true,multiplier:1,positiveColor:"#22c55e",negativeColor:"#ef4444"},
  stocks:{label:"Stocks",unit:"shares",unitSingular:"share",qtyLabel:"Shares",qtyLabelSingular:"Share",priceLabel:"Share Price",directions:["LONG","SHORT"],showStrike:false,showExpiry:false,multiplier:1,positiveColor:"#22c55e",negativeColor:"#ef4444"},
  futures:{label:"Futures",unit:"contracts",unitSingular:"contract",qtyLabel:"Contracts",qtyLabelSingular:"Contract",priceLabel:"Price",directions:["LONG","SHORT"],showStrike:false,showExpiry:true,multiplier:1,positiveColor:"#22c55e",negativeColor:"#ef4444"},
  forex:{label:"Forex",unit:"lots",unitSingular:"lot",qtyLabel:"Lots",qtyLabelSingular:"Lot",priceLabel:"Price",directions:["BUY","SELL"],showStrike:false,showExpiry:false,multiplier:1,positiveColor:"#22c55e",negativeColor:"#ef4444"},
  crypto:{label:"Crypto",unit:"units",unitSingular:"unit",qtyLabel:"Units",qtyLabelSingular:"Unit",priceLabel:"Price",directions:["LONG","SHORT"],showStrike:false,showExpiry:false,multiplier:1,positiveColor:"#22c55e",negativeColor:"#ef4444"}
};
var ASSET_CLASS_ORDER=["options","stocks","futures","forex","crypto"];
// CHANGED: Futures contract specs (point value $/point, tick size). Sources: CME, IBKR. Used for accurate P&L calc.
var FUTURES_SPECS={
  // E-mini Equity Indices
  ES:{name:"E-mini S&P 500",pointValue:50,tickSize:0.25},
  MES:{name:"Micro E-mini S&P 500",pointValue:5,tickSize:0.25},
  NQ:{name:"E-mini Nasdaq-100",pointValue:20,tickSize:0.25},
  MNQ:{name:"Micro E-mini Nasdaq",pointValue:2,tickSize:0.25},
  YM:{name:"E-mini Dow",pointValue:5,tickSize:1},
  MYM:{name:"Micro E-mini Dow",pointValue:0.5,tickSize:1},
  RTY:{name:"E-mini Russell 2000",pointValue:50,tickSize:0.1},
  M2K:{name:"Micro E-mini Russell",pointValue:5,tickSize:0.1},
  // Energy
  CL:{name:"Crude Oil",pointValue:1000,tickSize:0.01},
  MCL:{name:"Micro Crude Oil",pointValue:100,tickSize:0.01},
  NG:{name:"Natural Gas",pointValue:10000,tickSize:0.001},
  QM:{name:"E-mini Crude Oil",pointValue:500,tickSize:0.025},
  // Metals
  GC:{name:"Gold",pointValue:100,tickSize:0.1},
  MGC:{name:"Micro Gold",pointValue:10,tickSize:0.1},
  SI:{name:"Silver",pointValue:5000,tickSize:0.005},
  SIL:{name:"Micro Silver",pointValue:1000,tickSize:0.005},
  HG:{name:"Copper",pointValue:25000,tickSize:0.0005},
  // Treasuries
  ZB:{name:"30-Yr Treasury Bond",pointValue:1000,tickSize:0.03125},
  ZN:{name:"10-Yr T-Note",pointValue:1000,tickSize:0.015625},
  ZF:{name:"5-Yr T-Note",pointValue:1000,tickSize:0.0078125},
  ZT:{name:"2-Yr T-Note",pointValue:2000,tickSize:0.0078125},
  // Currencies
  "6E":{name:"Euro FX",pointValue:125000,tickSize:0.00005},
  "6J":{name:"Japanese Yen",pointValue:12500000,tickSize:0.0000005},
  "6B":{name:"British Pound",pointValue:62500,tickSize:0.0001},
  "6A":{name:"Australian Dollar",pointValue:100000,tickSize:0.0001},
  "6C":{name:"Canadian Dollar",pointValue:100000,tickSize:0.00005},
  // Crypto
  BTC:{name:"Bitcoin Futures",pointValue:5,tickSize:5},
  MBT:{name:"Micro Bitcoin",pointValue:0.1,tickSize:5},
  ETH:{name:"Ether Futures",pointValue:50,tickSize:0.5}
};
function getFuturesSpec(symbol){if(!symbol)return null;return FUTURES_SPECS[symbol.toUpperCase()]||null;}
function getFuturesPointValue(symbol){var s=getFuturesSpec(symbol);return s?s.pointValue:1;}
function getAssetClass(id){return ASSET_CLASSES[id]||ASSET_CLASSES.options;}
function getDirectionColor(dir){if(!dir)return "#64748b";if(dir==="CALL"||dir==="LONG"||dir==="BUY")return "#22c55e";if(dir==="PUT"||dir==="SHORT"||dir==="SELL")return "#ef4444";return "#64748b";}
function defaultEnabledAssetClasses(){return {options:true,stocks:false,futures:false,forex:false,crypto:false};}
function defaultFormSections(){return {timeframe:true,candlePattern:true,indicators:true};}
function defaultAssetClassSettings(){var out={};ASSET_CLASS_ORDER.forEach(function(id){out[id]={positionMinPct:null,positionMaxPct:null,riskMinPct:null,riskMaxPct:null,formSections:defaultFormSections()};});return out;}
function getFormSectionsForClass(settings,classId){var acs=(settings&&settings.assetClassSettings)||{};var c=acs[classId]||{};return Object.assign({},defaultFormSections(),c.formSections||{});}
var INSTRUMENTS_KEY="tf-instruments";
function loadInstruments(){try{var s=localStorage.getItem(INSTRUMENTS_KEY);if(!s)return [];var p=JSON.parse(s);return Array.isArray(p)?p:[];}catch(e){return [];}}
function saveInstruments(list){try{localStorage.setItem(INSTRUMENTS_KEY,JSON.stringify(list||[]));}catch(e){}}
function getInstrumentsForClass(list,classId){return (list||[]).filter(function(it){return it.classId===classId;});}
function migrateTrade(t){
  if(!t)return t;var out=t;
  // CHANGED: Rename legacy violation "Stop loss moved or not set" → "Max risk exceeded".
  if(Array.isArray(out.violations)&&out.violations.indexOf("Stop loss moved or not set")>=0){
    var renamed=out.violations.map(function(v){return v==="Stop loss moved or not set"?"Max risk exceeded":v;});
    // De-dupe in case both names somehow coexist.
    var seenV={};renamed=renamed.filter(function(v){if(seenV[v])return false;seenV[v]=true;return true;});
    out=Object.assign({},out,{violations:renamed});
  }
  if(!t.assetClass){out=Object.assign({},out,{assetClass:"options",instrument:t.instrument||"",status:t.status||(t.closedAt?"closed":"open")});}
  var entries=out.entries||[];var exits=out.exits||[];
  if(entries.length>0){
    var rawCost=0,tc=0;
    entries.forEach(function(en){var ec=parseFloat(en.contracts),ep=parseFloat(en.price);if(!isNaN(ec)&&!isNaN(ep)){tc+=ec;rawCost+=ec*ep;}});
    if(rawCost>0){
      var rawStr=rawCost.toFixed(2);
      var newPos=out.positionSize!==rawStr?{positionSize:rawStr}:{};
      var avg=tc>0?rawCost/tc:NaN;
      if(!isNaN(avg)&&exits.length>0){
        var tp=0;
        exits.forEach(function(ex){var ec=parseFloat(ex.contracts),ep=parseFloat(ex.price);if(!isNaN(ec)&&!isNaN(ep)){tp+=(ep-avg)*ec;}});
        var pnlStr=tp.toFixed(2);
        if(out.pnl!==pnlStr)newPos.pnl=pnlStr;
      }
      // CHANGED: Fix pctPnl sign mismatch from old PUT-flip bug — derive % from price move, not stored value.
      if(!isNaN(avg)&&avg!==0&&exits.length>0){
        var tv=0,txc=0;
        exits.forEach(function(ex){var ec=parseFloat(ex.contracts),ep=parseFloat(ex.price);if(!isNaN(ec)&&!isNaN(ep)){tv+=ep*ec;txc+=ec;}});
        if(txc>0){
          var pctStr=((tv/txc-avg)/avg*100).toFixed(2);
          if(out.pctPnl!==pctStr)newPos.pctPnl=pctStr;
        }
      }
      if(Object.keys(newPos).length>0)out=Object.assign({},out,newPos);
    }
  }
  return out;
}
function migrateTrades(arr){var seen={};var out=[];(arr||[]).forEach(function(t){var migrated=migrateTrade(t);if(migrated&&migrated.id!=null&&!seen[migrated.id]){seen[migrated.id]=true;out.push(migrated);}});return out;}

// CHANGED: Pre-market checklist items are now configurable via settings.
var DEFAULT_CHECKLIST_ITEMS=[
  {key:"sleptWell",label:"Slept well / rested",cat:"Mental",inverted:false},
  {key:"identifiedPDH",label:"Identified PDH",cat:"Levels",inverted:false},
  {key:"identifiedPDL",label:"Identified PDL",cat:"Levels",inverted:false},
  {key:"marked15minOpen",label:"15-min OBR marked",cat:"Levels",inverted:false},
  {key:"positionSized",label:"Double-checked sizing",cat:"Risk",inverted:false}
];
function loadChecklistItems(){
  try{var s=localStorage.getItem(CHECKLIST_KEY);if(s){var p=JSON.parse(s);if(Array.isArray(p)&&p.length>0){
    // CHANGED: Migrate — strip Conditions category items, they live separately now.
    return p.filter(function(it){return (it.cat||"").toLowerCase()!=="conditions";});
  }}}catch(e){}
  return DEFAULT_CHECKLIST_ITEMS.slice();
}
function saveChecklistItems(items){try{localStorage.setItem(CHECKLIST_KEY,JSON.stringify(items));}catch(e){}}
// CHANGED: Conditions checklist — independent from pre-market checklist.
var CONDITIONS_KEY="tf-conditions-items";
var DEFAULT_CONDITIONS_ITEMS=[
  {key:"candlesOverlapping",label:"Are candles overlapping? If yes it is choppy.",inverted:true}
];
function loadConditionsItems(){
  try{var s=localStorage.getItem(CONDITIONS_KEY);if(s){var p=JSON.parse(s);if(Array.isArray(p))return p;}}catch(e){}
  // One-time migration: import any Conditions items from the old checklist.
  try{
    var old=localStorage.getItem(CHECKLIST_KEY);
    if(old){
      var arr=JSON.parse(old);
      if(Array.isArray(arr)){
        var imported=arr.filter(function(it){return (it.cat||"").toLowerCase()==="conditions";}).map(function(it){return {key:it.key,label:it.label,inverted:!!it.inverted};});
        if(imported.length>0){localStorage.setItem(CONDITIONS_KEY,JSON.stringify(imported));return imported;}
      }
    }
  }catch(e){}
  return DEFAULT_CONDITIONS_ITEMS.slice();
}
function saveConditionsItems(items){try{localStorage.setItem(CONDITIONS_KEY,JSON.stringify(items));}catch(e){}}

// CHANGED: Pre-trade checklist — separate, scoped per asset class. Shown in the trade form.
// The form is locked except for the Asset Class selector until every item is checked.
var PRETRADE_KEY="tf-pretrade-checklist";
var DEFAULT_PRETRADE_ITEMS={
  options:[
    {key:"opt_setup",label:"Setup confirmed on 5m + higher timeframe",cat:"Setup",inverted:false},
    {key:"opt_iv",label:"IV acceptable, not earnings-inflated",cat:"Conditions",inverted:false},
    {key:"opt_dte",label:"DTE chosen intentionally",cat:"Risk",inverted:false},
    {key:"opt_stop",label:"Stop loss identified",cat:"Risk",inverted:false}
  ],
  stocks:[
    {key:"stk_setup",label:"Setup confirmed",cat:"Setup",inverted:false},
    {key:"stk_volume",label:"Volume confirms move",cat:"Conditions",inverted:false},
    {key:"stk_stop",label:"Stop loss identified",cat:"Risk",inverted:false},
    {key:"stk_size",label:"Position size within risk limit",cat:"Risk",inverted:false}
  ],
  futures:[
    {key:"fut_setup",label:"Setup confirmed",cat:"Setup",inverted:false},
    {key:"fut_levels",label:"Key levels marked",cat:"Levels",inverted:false},
    {key:"fut_stop",label:"Stop loss identified (in ticks)",cat:"Risk",inverted:false},
    {key:"fut_news",label:"No major news in next 30 min",cat:"Conditions",inverted:false}
  ],
  forex:[
    {key:"fx_setup",label:"Setup confirmed",cat:"Setup",inverted:false},
    {key:"fx_news",label:"No high-impact news pending",cat:"Conditions",inverted:false},
    {key:"fx_stop",label:"Stop loss identified (in pips)",cat:"Risk",inverted:false},
    {key:"fx_session",label:"Within active session for this pair",cat:"Conditions",inverted:false}
  ],
  crypto:[
    {key:"cry_setup",label:"Setup confirmed",cat:"Setup",inverted:false},
    {key:"cry_liquidity",label:"Liquidity sufficient on this pair",cat:"Conditions",inverted:false},
    {key:"cry_stop",label:"Stop loss identified",cat:"Risk",inverted:false}
  ]
};
function loadPretradeChecklist(){
  try{var s=localStorage.getItem(PRETRADE_KEY);if(s){var p=JSON.parse(s);if(p&&typeof p==="object")return Object.assign({},DEFAULT_PRETRADE_ITEMS,p);}}catch(e){}
  return Object.assign({},DEFAULT_PRETRADE_ITEMS);
}
function savePretradeChecklist(map){try{localStorage.setItem(PRETRADE_KEY,JSON.stringify(map));}catch(e){}}
function getPretradeItemsForClass(classId,selectedSetup){
  var map=loadPretradeChecklist();
  var items=map[classId]||[];
  // CHANGED: Filter by setup. Items with no `setup` (or empty) show for all setups.
  // Items with a `setup` value only show when that setup is selected.
  if(!selectedSetup)return items.filter(function(it){return !it.setup;});
  return items.filter(function(it){return !it.setup||it.setup===selectedSetup;});
}
function isPreCheckComplete(checklist){
  var items=loadChecklistItems();
  // CHANGED: Conditions items are surfaced in the trade log banner, not gating the checklist.
  items=items.filter(function(it){return (it.cat||"").toLowerCase()!=="conditions";});
  var c=checklist||{};
  for(var i=0;i<items.length;i++){
    var item=items[i];
    var val=!!c[item.key];
    if(item.inverted){if(val)return false;}
    else {if(!val)return false;}
  }
  return true;
}
function buildEmptyChecklist(){
  var items=loadChecklistItems();
  var out={};
  items.forEach(function(it){out[it.key]=false;});
  return out;
}

// CHANGED: Editable Home "Focus" panel. Three day-states (red/green/neutral), each with a title,
// bullet items, and an enabled flag for whether the panel shows on that kind of day.
function defaultFocusStates(){return {
  red:{enabled:true,title:"Today's Focus",items:["Today is a new day","Minimize losses","Take only A setups","No upsizing today"]},
  green:{enabled:true,title:"Today's Focus",items:["Protect yesterday's profits","Upsize only on trend continuation"]},
  neutral:{enabled:true,title:"Today's Focus",items:["Stay disciplined","Take only A setups","Follow your plan"]}
};}
function getFocusStates(settings){
  var base=defaultFocusStates();
  var src=settings&&settings.focusStates?settings.focusStates:{};
  var out={};
  ["red","green","neutral"].forEach(function(k){
    out[k]=Object.assign({},base[k],src[k]||{});
    out[k].items=Array.isArray(out[k].items)?out[k].items.slice():base[k].items.slice();
  });
  return out;
}
function defaultSettings(){return {accountSize:0,positionMin:0,positionMax:0,riskMin:0,riskMax:0,gainMultiplier:5,timezone:"America/Los_Angeles",sessions:defaultSessionsForTz("America/Los_Angeles"),tradingWindows:[{start:60,end:1020}],slippagePct:20,positionMaxPct:7.5,positionMaxDollar:500,riskMaxPct:33,riskMaxDollar:165,sizingMode:"pct",hideDollarPnL:false,enabledAssetClasses:defaultEnabledAssetClasses(),assetClassSettings:defaultAssetClassSettings(),defaultAssetClass:"options",defaultInstruments:{},focusStates:defaultFocusStates()};}

var HIDE_DOLLAR_PNL=false;
function setHideDollarPnL(v){HIDE_DOLLAR_PNL=!!v;}
function fmtMoney(n){if(HIDE_DOLLAR_PNL)return "$•••";var v=Math.abs(parseFloat(n)||0);return "$"+v.toFixed(2);}
function fmtSignedMoney(n){var v=parseFloat(n)||0;if(HIDE_DOLLAR_PNL)return (v>=0?"+":"−")+"$•••";return (v>=0?"+":"−")+"$"+Math.abs(v).toFixed(2);}
function $fmt(n,opts){opts=opts||{};if(HIDE_DOLLAR_PNL)return (opts.signed&&n>=0?"+":opts.signed&&n<0?"−":"")+"$•••";var v=parseFloat(n)||0;var sign=opts.signed?(v>=0?"+":"−"):"";return sign+"$"+Math.abs(v).toFixed(opts.decimals!=null?opts.decimals:2);}
// CHANGED: When $ is hidden, dollar position/risk amounts are shown as a % of current account balance.
function pctOfAccount(dollars){
  try{var bal=computeAccountBalance(0);if(bal>0)return ((parseFloat(dollars)||0)/bal*100).toFixed(1)+"%";}catch(e){}
  return "—";
}
// Position display helper: $ normally, % of account when $ hidden.
function fmtPositionDisplay(pos){return HIDE_DOLLAR_PNL?pctOfAccount(pos):("$"+Number(pos).toLocaleString(undefined,{maximumFractionDigits:0}));}
function defaultChecklist(){return {sleptWell:false,identifiedPDH:false,identifiedPDL:false,marked15minOpen:false,positionSized:false,candlesOverlapping:false};}
function defaultState(){return {date:todayStr(),preChecklist:defaultChecklist(),conditionsChecked:{},trades:[],dailyNote:"",ruleViolations:[],commitment:null,noTradeReason:"",noTradeReasons:[],noTradeShots:[]};}
// CHANGED: Each leg gets its own timestamp on creation. Editable in the form.
function mkEntry(){return {id:Date.now()+Math.random(),contracts:"",price:"",time:Date.now()};}
function mkExit(){return {id:Date.now()+Math.random(),contracts:"",price:"",time:Date.now()};}
function mkTrade(){return {id:Date.now(),openedAt:Date.now(),closedAt:null,time:fmtTime(getNow()),assetClass:"",instrument:"",direction:"",entries:[],exits:[],stopLoss:"",contracts:"",positionSize:"",pnl:"",pctPnl:"",setup:"",candlePattern:"",timeframe:"",indicators:[],grade:"",emotions:[],violations:[],notes:"",screenshots:[],strike:"",expiry:"",sessionId:null,sizeFraction:1,status:"closed"};}
// CHANGED: Helpers to merge/read fields on a journal entry by date. Used to persist the
// discipline-lock note and lock metadata onto the locked day's journal row.
function updateJournalEntryFields(date,fields){
  try{
    var k="journal:"+date.replace(/\//g,"-");
    var s=localStorage.getItem(k);
    var entry=s?JSON.parse(s):{date:date,pnl:0,trades:[],wins:0,losses:0,disciplineScore:0,riskMax:0};
    Object.assign(entry,fields);
    localStorage.setItem(k,JSON.stringify(entry));
  }catch(e){}
}
function getJournalEntryField(date,field){
  try{
    var k="journal:"+date.replace(/\//g,"-");
    var s=localStorage.getItem(k);
    if(!s)return null;
    var entry=JSON.parse(s);
    return entry?entry[field]:null;
  }catch(e){return null;}
}
// CHANGED: Helper used by every journal-entry writer. On quota error, retries with all trade
// screenshots stripped so the day's totals still persist (otherwise edits silently fail to save).
// Returns the entry that was actually written (may be a screenshot-stripped variant) or null on failure.
function safeWriteJournalEntry(key,entry){
  try{localStorage.setItem(key,JSON.stringify(entry));return entry;}
  catch(qe){
    var isQuota=qe&&(qe.name==="QuotaExceededError"||/quota/i.test(qe.message||""));
    if(!isQuota)return null;
    try{
      var stripped=Object.assign({},entry,{trades:(entry.trades||[]).map(function(x){var c=Object.assign({},x);c.screenshots=[];return c;}),screenshotsStripped:true});
      localStorage.setItem(key,JSON.stringify(stripped));
      // CHANGED: non-blocking warning so save isn't paused waiting for the user to dismiss.
      try{console.warn("Storage full — saved without screenshots for "+key);}catch(e){}
      return stripped;
    }catch(e2){
      try{console.error("Journal save failed for "+key+":",e2);}catch(e){}
      return null;
    }
  }
}
function loadJournalRows(){
  var rows=[];
  for(var i=0;i<localStorage.length;i++){
    var k=localStorage.key(i);
    if(k&&k.startsWith("journal:")){
      try{
        var p=JSON.parse(localStorage.getItem(k));
        if(p&&typeof p.pnl!=="undefined"){
          if(p.trades)p.trades=migrateTrades(p.trades);
          // Migrate old entries without riskMax - use a default of 100
          if(p.riskMax==null)p.riskMax=100;
          rows.push(p);
        }
      }catch(e){}
    }
  }
  return rows;
}
// CHANGED: Track per-day trade count so the calendar can render R only for days that actually
// had trades. A day with zero trades (even one with saved pnl=0 / a riskMax) shows blank, not "+0.0R".
function buildSessionMap(todayPnL,todayRiskMax,todayTradeCount){
  var map={};
  loadJournalRows().forEach(function(s){
    var tc=Array.isArray(s.trades)?s.trades.filter(function(t){return t&&t.status!=="open";}).length:((parseFloat(s.wins)||0)+(parseFloat(s.losses)||0));
    // CHANGED: Include wasLocked so calendars can flag days where discipline lock triggered.
    map[s.date]={pnl:parseFloat(s.pnl)||0,riskMax:parseFloat(s.riskMax)||0,tradeCount:tc,noTradeDay:!!s.noTradeDay,wasLocked:!!s.wasLocked};
  });
  // CHANGED: Only inject today's live data when there's no saved journal entry for today.
  // Otherwise the saved journal pnl gets overwritten by stale/zero live state (e.g. after rollover or
  // before state.trades hydrates), causing week P&L to drop today's contribution.
  var tc=parseInt(todayTradeCount)||0;
  var todayKey=todayStr();
  if(!map[todayKey]&&(tc>0||todayPnL!==0||todayRiskMax>0)){
    map[todayKey]={pnl:todayPnL,riskMax:todayRiskMax||0,tradeCount:tc,noTradeDay:false};
  }else if(map[todayKey]&&tc>map[todayKey].tradeCount){
    // Journal exists but the live state has more trades than the saved entry — trust the live count.
    map[todayKey]=Object.assign({},map[todayKey],{tradeCount:tc});
  }
  return map;
}

// Gamification system
var GAMIFICATION_KEY="tf-gamification";
var WEEKLY_CHALLENGE_KEY="tf-weekly-challenges";
function loadGamificationData(){try{var s=localStorage.getItem(GAMIFICATION_KEY);if(!s)return {bestStreak:0,lastStreakLevel:0,lastWithdrawalLevel:0,lastRankLevel:0,seenAchievements:[]};return JSON.parse(s);}catch(e){return {bestStreak:0,lastStreakLevel:0,lastWithdrawalLevel:0,lastRankLevel:0,seenAchievements:[]};}}
function saveGamificationData(data){try{localStorage.setItem(GAMIFICATION_KEY,JSON.stringify(data));}catch(e){}}
function calculateStreak(includeToday){
  // CHANGED: A streak only breaks on a RED trading day. Days with no trades, weekends, and
  // market holidays are skipped (they neither extend nor break the streak).
  var rows=loadJournalRows();
  var byDate={};
  rows.forEach(function(r){byDate[r.date]=r;});
  var streak=0;
  var checkDate=getPT();checkDate.setHours(0,0,0,0);
  if(!includeToday)checkDate.setDate(checkDate.getDate()-1);
  // Walk backward a bounded number of days; skip non-trading days, break only on a red day.
  for(var i=0;i<400;i++){
    var key=checkDate.toLocaleDateString("en-US");
    var dow=checkDate.getDay();
    var isWeekend=(dow===0||dow===6);
    var isHoliday=!!MARKET_HOLIDAYS[key];
    var row=byDate[key];
    var hadTrades=row&&((row.trades&&row.trades.length>0)||(row.wins||0)+(row.losses||0)>0);
    if(isWeekend||isHoliday||!hadTrades){
      // Non-trading or no-activity day — skip without affecting the streak.
      checkDate.setDate(checkDate.getDate()-1);
      continue;
    }
    if(parseFloat(row.pnl)>0){streak++;checkDate.setDate(checkDate.getDate()-1);}
    else{break;} // a day with trades that netted <= 0 breaks the streak
  }
  return streak;
}
// CHANGED: CLEAN-DAY STREAK — process-based, NOT profit-based. A day is "clean" when its
// discipline score (process-only) stays at or above the lock threshold. Per design choice,
// violations are allowed as long as the score survives the bar. Only trading days count;
// weekends, holidays, and no-trade days are skipped (they neither extend nor break the streak),
// mirroring calculateStreak's skip logic so the two feel consistent. A red but disciplined day
// KEEPS the streak — that's the whole point: we reward staying clean, win or lose.
function dayIsClean(row){
  if(!row)return false;
  var thr=loadDisciplineLockThreshold();
  var score;
  if(row.trades&&row.trades.length>0){score=calcDiscipline(row.trades,row.riskMax,{processOnly:true});}
  else if(row.disciplineScore!=null){score=parseFloat(row.disciplineScore);}
  else{return false;}
  return score>=thr;
}
function calculateCleanStreak(includeToday){
  var rows=loadJournalRows();
  var byDate={};
  rows.forEach(function(r){byDate[r.date]=r;});
  var streak=0;
  var checkDate=getPT();checkDate.setHours(0,0,0,0);
  if(!includeToday)checkDate.setDate(checkDate.getDate()-1);
  for(var i=0;i<400;i++){
    var key=checkDate.toLocaleDateString("en-US");
    var dow=checkDate.getDay();
    var isWeekend=(dow===0||dow===6);
    var isHoliday=!!MARKET_HOLIDAYS[key];
    var row=byDate[key];
    var hadTrades=row&&((row.trades&&row.trades.length>0)||(row.wins||0)+(row.losses||0)>0);
    if(isWeekend||isHoliday||!hadTrades){checkDate.setDate(checkDate.getDate()-1);continue;}
    if(dayIsClean(row)){streak++;checkDate.setDate(checkDate.getDate()-1);}
    else{break;} // a trading day below the lock threshold breaks the clean streak
  }
  return streak;
}
// Personal best is persisted and updated whenever the current streak exceeds it.
function getCleanStreakBest(){try{var v=parseFloat(localStorage.getItem("tf-clean-streak-best"));return isNaN(v)?0:v;}catch(e){return 0;}}
function updateCleanStreakBest(current){try{if(current>getCleanStreakBest())localStorage.setItem("tf-clean-streak-best",String(current));}catch(e){}return Math.max(current,getCleanStreakBest());}
// CHANGED: A-GRADE-DAY STREAK — a trading day counts when EVERY closed trade that day is graded "A".
// Same skip logic as the other streaks (weekends/holidays/no-trade days are skipped).
function dayIsAllAGrade(row){
  if(!row)return false;
  var closed=(row.trades||[]).filter(function(t){return t&&t.status!=="open";});
  if(closed.length===0)return false;
  return closed.every(function(t){return t.grade==="A";});
}
function calculateAGradeStreak(includeToday){
  var rows=loadJournalRows();
  var byDate={};
  rows.forEach(function(r){byDate[r.date]=r;});
  var streak=0;
  var checkDate=getPT();checkDate.setHours(0,0,0,0);
  if(!includeToday)checkDate.setDate(checkDate.getDate()-1);
  for(var i=0;i<400;i++){
    var key=checkDate.toLocaleDateString("en-US");
    var dow=checkDate.getDay();
    var isWeekend=(dow===0||dow===6);
    var isHoliday=!!MARKET_HOLIDAYS[key];
    var row=byDate[key];
    var hadTrades=row&&((row.trades&&row.trades.length>0)||(row.wins||0)+(row.losses||0)>0);
    if(isWeekend||isHoliday||!hadTrades){checkDate.setDate(checkDate.getDate()-1);continue;}
    if(dayIsAllAGrade(row)){streak++;checkDate.setDate(checkDate.getDate()-1);}
    else{break;}
  }
  return streak;
}
// Is today's in-progress day still clean / at risk? Used for the "streak at risk" friction cue.
function todayCleanStatus(todayTrades,todayRiskMax){
  var closed=(todayTrades||[]).filter(function(t){return t&&t.status!=="open";});
  if(closed.length===0)return "none"; // no closed trades yet today
  var thr=loadDisciplineLockThreshold();
  var score=calcDiscipline(closed,todayRiskMax,{processOnly:true});
  return score>=thr?"clean":"atrisk";
}
// CHANGED: PRE-MARKET COMMITMENT — the trader states a plan before the day (max trades + which
// setups they'll take). At day's end we score adherence against their OWN stated plan, which
// lands harder than a generic rule. Returns null if no commitment was made.
function scoreCommitment(state){
  var c=state&&state.commitment;
  if(!c||!c.committed)return null;
  var closed=(state.trades||[]).filter(function(t){return t&&t.status!=="open";});
  var actualTrades=closed.length;
  var maxT=parseInt(c.maxTrades);
  var hasMax=!isNaN(maxT)&&maxT>0;
  var overTrades=hasMax&&actualTrades>maxT;
  // Adherence: kept the trade cap (or none set). Setups are qualitative (self-affirmed at review).
  var kept=[];
  var broke=[];
  if(hasMax){(overTrades?broke:kept).push(overTrades?("Took "+actualTrades+" trades vs. committed max of "+maxT):("Stayed within your "+maxT+"-trade cap ("+actualTrades+" taken)"));}
  if(c.setupsReviewAffirmed===true)kept.push("Traded only your committed setups");
  if(c.setupsReviewAffirmed===false)broke.push("Deviated from your committed setups");
  return {committed:true,maxTrades:hasMax?maxT:null,actualTrades:actualTrades,overTrades:overTrades,setups:c.setups||"",kept:kept,broke:broke,reviewed:c.reviewed===true,adhered:broke.length===0};
}
function getTotalWithdrawn(){
  return loadTransfers().filter(function(t){return String(t.type||"").toLowerCase()==="withdrawal";}).reduce(function(s,t){return s+Math.abs(parseFloat(t.amount)||0);},0);
}
// CHANGED: Daily target now derives from each enabled session's position size (sizeFraction) and
// gain hard stop (gainStopR): for one winning trade per enabled session that hits its gain stop,
// $ = riskMax × sizeFraction × gainStopR. Summed across enabled sessions = the "good day" target.
function computeDailyTarget(sp){
  if(!sp)return 0;
  var rm=parseFloat(sp.riskMax)||0;
  if(rm<=0)return 0;
  var sessions=getSessions(sp).filter(function(s){return s.enabled!==false;});
  if(sessions.length===0)return rm*(parseFloat(sp.gainMultiplier)||0); // fallback to legacy if no sessions
  return sessions.reduce(function(sum,s){
    var f=s.sizeFraction!=null?parseFloat(s.sizeFraction):1;
    var g=s.gainStopR!=null?parseFloat(s.gainStopR):2.5;
    if(isNaN(f))f=1;if(isNaN(g))g=2.5;
    return sum+rm*f*g;
  },0);
}
// Daily target derived from session sizing + gain hard stops. Falls back to 0 if unset.
function getDailyTarget(){
  try{var s=localStorage.getItem(SETTINGS_KEY);if(!s)return 0;return computeDailyTarget(JSON.parse(s));}catch(e){return 0;}
}
// Withdrawals expressed in "days" — how many daily targets you've pulled out. Used by rank + milestones.
function getWithdrawnInDays(withdrawn){var dt=getDailyTarget();return dt>0?(withdrawn/dt):0;}
// CHANGED: Points and ranks removed entirely. Achievements and challenges are tracked only as
// completion counts now — no point values, no rank tiers.
// Lifetime challenge completions are tallied across weeks and stored in gamification data.
function getChallengeCompletions(){var d=loadGamificationData();return d.challengeCompletions||0;}
// How many ranks earned = how many withdrawals unlocked (1 per tier crossed).
// CHANGED: Ranks/points are now a COSMETIC progression badge only — they no longer gate or grant
// withdrawals. The withdrawal allowance below depends solely on account growth (profit since last
// withdrawal). getRanksEarned/getWithdrawalsRemaining were removed as they served only the old gate.
// CHANGED: Withdrawal allowance = flat % of profit earned SINCE the last withdrawal.
// Ranks gate ACCESS (must be >= Bronze); the allowance amount is a flat % of recent profit.
var WITHDRAWAL_ALLOWANCE_PCT=30; // flat % of profit-since-last-withdrawal
function getLastWithdrawalDate(){
  var ws=loadTransfers().filter(function(t){return String(t.type||"").toLowerCase()==="withdrawal";});
  if(!ws.length)return null;
  var latest=null;
  ws.forEach(function(t){var d=new Date(t.date);if(!isNaN(d.getTime())){if(!latest||d>latest)latest=d;}});
  return latest;
}
// Profit-since-last-withdrawal — CHANGED: timestamp-based, using each withdrawal's `id`
// (which is Date.now() at creation) as the cutoff. Trades' `closedAt` is also a timestamp, so we
// simply sum the P&L of every closed trade whose closedAt is strictly after the latest withdrawal
// timestamp. This correctly handles same-day withdraw-then-trade scenarios and stays robust even
// if the user has historically over-withdrawn (the counter resets at each withdrawal).
function getProfitSinceLastWithdrawal(todayPnL){
  var ws=loadTransfers().filter(function(t){return String(t.type||"").toLowerCase()==="withdrawal";});
  var cutoff=0;
  ws.forEach(function(t){var id=parseFloat(t.id)||0;if(id>cutoff)cutoff=id;});
  // No withdrawals yet → all-time profit applies. Fall back to lifetime pnl + live today pnl.
  if(cutoff===0){
    var rows=loadJournalRows();
    var today=todayStr();
    var sum=0;
    rows.forEach(function(r){if(r.date===today)return;sum+=parseFloat(r.pnl)||0;});
    if(typeof todayPnL==="number"&&!isNaN(todayPnL))sum+=todayPnL;
    return sum;
  }
  // Sum closed-trade pnl across all journal rows where closedAt > cutoff.
  var sum=0;
  var today=todayStr();
  loadJournalRows().forEach(function(r){
    if(r.date===today)return; // today handled live below
    (r.trades||[]).forEach(function(t){
      if(t&&t.status!=="open"){
        var ca=parseFloat(t.closedAt)||0;
        if(ca>cutoff)sum+=parseFloat(t.pnl)||0;
      }
    });
  });
  // Live today: load state from localStorage to get closedAt timestamps (todayPnL alone lacks them).
  try{
    var s=localStorage.getItem(STORAGE_KEY);
    if(s){
      var p=JSON.parse(s);
      if(p&&p.date===today&&Array.isArray(p.trades)){
        p.trades.forEach(function(t){
          if(t&&t.status!=="open"){
            var ca=parseFloat(t.closedAt)||0;
            if(ca>cutoff)sum+=parseFloat(t.pnl)||0;
          }
        });
      }
    }
  }catch(e){}
  return sum;
}
// Dollar allowance available right now. CHANGED: withdrawals are now gated purely by account growth —
// the points/rank system no longer controls access. If there's positive profit since the last
// withdrawal, you can withdraw a flat % of it. Achievements/Challenges are motivational only.
function getWithdrawalAllowance(todayPnL){
  var profit=getProfitSinceLastWithdrawal(todayPnL);
  if(profit<=0)return 0;
  return profit*(WITHDRAWAL_ALLOWANCE_PCT/100);
}
// CHANGED: Optional allowance-target notification. The user sets a $ target; when the live allowance
// reaches it, a banner appears on Home. We persist the target and a "dismissed-at-target" marker so
// the banner doesn't nag once acknowledged (it re-arms if the target changes or allowance dips below).
function getAllowanceTarget(){try{var v=parseFloat(localStorage.getItem("tf-allowance-target"));return isNaN(v)?0:v;}catch(e){return 0;}}
// CHANGED: Half-size next-trade guard. After yesterday closed at +3R or higher, suggest sizing
// down on TODAY's first trade — a single-trade speed bump to interrupt the post-win dopamine
// loop. Threshold defaults to 3R; reads from settings if user sets one.
function getHalfSizeRThreshold(){try{var v=parseFloat(localStorage.getItem("tf-halfsize-r-threshold"));return isNaN(v)||v<=0?3:v;}catch(e){return 3;}}
function getLastDayR(){
  try{
    var rows=loadJournalRows().filter(function(r){return (r.trades||[]).length>0;}).sort(function(a,b){return new Date(b.date)-new Date(a.date);});
    if(rows.length===0)return {date:null,r:0,pnl:0};
    var r=rows[0];var pnl=parseFloat(r.pnl)||0;
    // CHANGED: Prefer the entry's STORED riskMax (the value at save time) over the current
    // settings — keeps the banner's R math identical to what the calendar / day tiles show.
    // Falls back to current settings only if the entry is missing it.
    var risk=parseFloat(r.riskMax);
    if(isNaN(risk)||risk<=0){try{var s=JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}");risk=parseFloat(s.riskMax)||0;}catch(e){risk=0;}}
    var rMult=risk>0?(pnl/risk):0;
    return {date:r.date,r:rMult,pnl:pnl};
  }catch(e){return {date:null,r:0,pnl:0};}
}
function halfSizeNudgeDismissedFor(dateStr){try{return localStorage.getItem("tf-halfsize-dismissed")===dateStr;}catch(e){return false;}}
function dismissHalfSizeNudge(dateStr){try{localStorage.setItem("tf-halfsize-dismissed",dateStr);}catch(e){}}
// CHANGED: Profit-taking nudge. After N consecutive green days, suggest taking a withdrawal.
// Dismissal stores the streak length at the time of dismissal; banner reappears only if the
// streak grows beyond that, so we don't nag on the same plateau.
function getStreakNudgeThreshold(){try{var v=parseFloat(localStorage.getItem("tf-streak-nudge-threshold"));return isNaN(v)||v<=0?3:v;}catch(e){return 3;}}
function streakNudgeDismissedAt(){try{var v=parseInt(localStorage.getItem("tf-streak-nudge-dismissed-at"),10);return isNaN(v)?0:v;}catch(e){return 0;}}
function dismissStreakNudge(streakLen){try{localStorage.setItem("tf-streak-nudge-dismissed-at",String(streakLen));}catch(e){}}
function saveAllowanceTarget(v){try{if(v>0)localStorage.setItem("tf-allowance-target",String(v));else localStorage.removeItem("tf-allowance-target");localStorage.removeItem("tf-allowance-notif-dismissed");}catch(e){}}
function getAllowanceNotifDismissed(){try{return localStorage.getItem("tf-allowance-notif-dismissed")==="1";}catch(e){return false;}}
function setAllowanceNotifDismissed(v){try{if(v)localStorage.setItem("tf-allowance-notif-dismissed","1");else localStorage.removeItem("tf-allowance-notif-dismissed");}catch(e){}}
// Withdrawal milestone in dollars = N daily-targets. Falls back to fixed $ if no target set.
function getWithdrawalDollarTarget(days){var dt=getDailyTarget();if(dt>0)return dt*days;var fallback={5:500,25:5000,100:25000};return fallback[days]||(days*100);}
function getWithdrawalThreshold(days){var dt=getDailyTarget();if(dt>0)return "$"+Math.round(dt*days).toLocaleString()+" ("+days+" days)";return null;}
var ACHIEVEMENTS=[
  {id:"first_win",icon:"🎯",name:"First Blood",desc:"First winning trade",check:function(r){return r.some(function(d){return (d.wins||0)>0;});}},
  {id:"first_withdrawal",icon:"💸",name:"The Take",desc:"First withdrawal",check:function(r,s,w){return w>0;}},
  {id:"streak3",icon:"🔥",name:"On Fire",desc:"3-day green streak",check:function(r,s){return s>=3;}},
  {id:"streak7",icon:"⚡",name:"Iron Hands",desc:"7-day green streak",check:function(r,s){return s>=7;}},
  {id:"streak14",icon:"🏔",name:"Unstoppable",desc:"14-day green streak",check:function(r,s){return s>=14;}},
  {id:"streak30",icon:"👑",name:"The Legend",desc:"30-day green streak",check:function(r,s){return s>=30;}},
  // CHANGED: Withdrawal achievements are now count-based at clean round numbers (5, 10, 25) rather
  // than tied to a multiple of the daily target. Rewards the HABIT of withdrawing regularly, not
  // the total $ amount — and the thresholds are immediately readable.
  {id:"withdrawal_n5",icon:"💰",name:"Stacking Up",desc:"5 withdrawals logged",check:function(){try{return (loadTransfers()||[]).filter(function(t){return (parseFloat(t.amount)||0)<0;}).length>=5;}catch(e){return false;}}},
  {id:"withdrawal_n10",icon:"🏦",name:"Routine",desc:"10 withdrawals logged",check:function(){try{return (loadTransfers()||[]).filter(function(t){return (parseFloat(t.amount)||0)<0;}).length>=10;}catch(e){return false;}}},
  {id:"withdrawal_n25",icon:"🚀",name:"Pro Withdrawer",desc:"25 withdrawals logged",check:function(){try{return (loadTransfers()||[]).filter(function(t){return (parseFloat(t.amount)||0)<0;}).length>=25;}catch(e){return false;}}},
  {id:"winrate60",icon:"🎖",name:"Sharp Eye",desc:"60%+ win rate (20+ trades)",check:function(r){var tot=r.reduce(function(s,d){return s+(d.wins||0)+(d.losses||0);},0);var wins=r.reduce(function(s,d){return s+(d.wins||0);},0);return tot>=20&&wins/tot>=0.6;}},
  {id:"winrate70",icon:"🔭",name:"Sniper",desc:"70%+ win rate (20+ trades)",check:function(r){var tot=r.reduce(function(s,d){return s+(d.wins||0)+(d.losses||0);},0);var wins=r.reduce(function(s,d){return s+(d.wins||0);},0);return tot>=20&&wins/tot>=0.7;}},
  {id:"disc90",icon:"🧘",name:"Iron Mind",desc:"90%+ avg discipline (10+ days)",check:function(r){var days=r.filter(function(d){return d.disciplineScore!=null;});if(days.length<10)return false;return days.reduce(function(s,d){return s+(parseFloat(d.disciplineScore)||0);},0)/days.length>=90;}},
  {id:"agrade5",icon:"⭐",name:"A-Game",desc:"5 A-grade trades in one day",check:function(r){return r.some(function(d){return (d.trades||[]).filter(function(t){return t.grade==="A";}).length>=5;});}},
  {id:"noviolations5",icon:"🛡",name:"Clean Hands",desc:"5 consecutive days, zero violations",check:function(r){var sorted=r.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);});var streak=0;for(var i=0;i<sorted.length;i++){if((sorted[i].trades||[]).some(function(t){return (t.violations||[]).length>0;}))break;streak++;}return streak>=5;}},
  // CHANGED: No-lock streaks — consecutive trading days where the discipline lock did NOT trigger.
  // Helper computes the longest current streak (most recent N days, walking back from today). A
  // no-trade day breaks the streak only if it's wasLocked; otherwise it's neutral and counts as
  // a non-lock day. Thresholds: 10, 25, 50 — clean round numbers, escalating commitment.
  {id:"nolock10",icon:"🪨",name:"Steady Hand",desc:"10 trading days, no lock triggers",check:function(r){var tradingDays=r.filter(function(d){return (d.trades||[]).length>0||d.noTradeDay;}).sort(function(a,b){return new Date(b.date)-new Date(a.date);});var streak=0;for(var i=0;i<tradingDays.length;i++){if(tradingDays[i].wasLocked)break;streak++;}return streak>=10;}},
  {id:"nolock25",icon:"⛰",name:"Bedrock",desc:"25 trading days, no lock triggers",check:function(r){var tradingDays=r.filter(function(d){return (d.trades||[]).length>0||d.noTradeDay;}).sort(function(a,b){return new Date(b.date)-new Date(a.date);});var streak=0;for(var i=0;i<tradingDays.length;i++){if(tradingDays[i].wasLocked)break;streak++;}return streak>=25;}},
  {id:"nolock50",icon:"🗿",name:"Unshakeable",desc:"50 trading days, no lock triggers",check:function(r){var tradingDays=r.filter(function(d){return (d.trades||[]).length>0||d.noTradeDay;}).sort(function(a,b){return new Date(b.date)-new Date(a.date);});var streak=0;for(var i=0;i<tradingDays.length;i++){if(tradingDays[i].wasLocked)break;streak++;}return streak>=50;}},
  {id:"trades50",icon:"📈",name:"Volume Trader",desc:"50 total trades logged",check:function(r){return r.reduce(function(s,d){return s+(d.wins||0)+(d.losses||0);},0)>=50;}},
  {id:"trades200",icon:"📊",name:"Market Veteran",desc:"200 total trades logged",check:function(r){return r.reduce(function(s,d){return s+(d.wins||0)+(d.losses||0);},0)>=200;}},
  {id:"balance5k",icon:"🪙",name:"Five Grand",desc:"Account balance reaches $5,000",check:function(){return getAccountBalance()>=5000;}},
  {id:"balance10k",icon:"💵",name:"Five Figures",desc:"Account balance reaches $10,000",check:function(){return getAccountBalance()>=10000;}},
  {id:"balance25k",icon:"💎",name:"Quarter Hundred",desc:"Account balance reaches $25,000",check:function(){return getAccountBalance()>=25000;}},
  {id:"balance50k",icon:"🏆",name:"Halfway to Six",desc:"Account balance reaches $50,000",check:function(){return getAccountBalance()>=50000;}},
  {id:"balance100k",icon:"👑",name:"Six Figures",desc:"Account balance reaches $100,000",check:function(){return getAccountBalance()>=100000;}},
];
function getEarnedAchievements(rows,streak,withdrawn){
  return ACHIEVEMENTS.filter(function(a){try{return a.check(rows,streak,withdrawn);}catch(e){return false;}});
}
// desc can be a string or a function (for settings-derived text). Resolve safely.
function achDesc(a){try{return typeof a.desc==="function"?a.desc():a.desc;}catch(e){return "";}}
function getWeekStart(){var now=getPT();var s=new Date(now.getFullYear(),now.getMonth(),now.getDate()-now.getDay());s.setHours(0,0,0,0);return s;}
function getWeekChallenges(rows){
  var ws=getWeekStart();
  var weekRows=rows.filter(function(r){return new Date(r.date)>=ws;});
  var totalWins=weekRows.reduce(function(s,r){return s+(r.wins||0);},0);
  var totalTrades=weekRows.reduce(function(s,r){return s+(r.wins||0)+(r.losses||0);},0);
  var wr=totalTrades>=5?(totalWins/totalTrades*100):0;
  // CHANGED: Green / A-grade challenges are STREAK-based, using the same streak calculators that
  // drive the Progress card (calculateStreak, calculateAGradeStreak) — consecutive qualifying days.
  var greenStreak=calculateStreak(true);
  var aGradeStreak=calculateAGradeStreak(true);
  // CHANGED: Green-streak and A-grade-streak challenges removed from this list — they now display
  // as standalone counters at the top of the Progress widget.
  return [
    {id:"wr55",icon:"🎯",name:"55%+ win rate (5+ trades)",target:55,current:Math.round(Math.min(55,wr)),done:wr>=55&&totalTrades>=5,suffix:"%"},
  ];
}
function getStreakMultiplier(streak){
  if(streak>=14)return 3.0;if(streak>=10)return 2.5;if(streak>=7)return 2.0;
  if(streak>=5)return 1.75;if(streak>=3)return 1.5;if(streak>=2)return 1.25;
  if(streak>=1)return 1.1;return 1.0;
}
function checkNewAchievements(rows,streak,withdrawn){
  var data=loadGamificationData();
  var seen=data.seenAchievements||[];
  var earned=getEarnedAchievements(rows,streak,withdrawn);
  var newOnes=earned.filter(function(a){return seen.indexOf(a.id)<0;});
  if(newOnes.length>0){saveGamificationData(Object.assign({},data,{seenAchievements:seen.concat(newOnes.map(function(a){return a.id;})),bestStreak:Math.max(streak,data.bestStreak||0)}));}
  return newOnes;
}
// Tally weekly-challenge completions into a lifetime counter, keyed by week so each completion counts once.
function syncChallengeCompletions(rows){
  var data=loadGamificationData();
  var ws=getWeekStart();
  var weekKey=(ws.getFullYear())+"-"+(ws.getMonth()+1)+"-"+ws.getDate();
  var ledger=data.challengeLedger||{};
  var challenges=getWeekChallenges(rows);
  var doneIds=challenges.filter(function(c){return c.done;}).map(function(c){return c.id;});
  var prevForWeek=ledger[weekKey]||[];
  // Union of previously-recorded and currently-done (challenges never "un-complete" within a week).
  var union=prevForWeek.slice();
  doneIds.forEach(function(id){if(union.indexOf(id)<0)union.push(id);});
  if(union.length!==prevForWeek.length){
    ledger[weekKey]=union;
    var total=0;Object.keys(ledger).forEach(function(k){total+=ledger[k].length;});
    saveGamificationData(Object.assign({},data,{challengeLedger:ledger,challengeCompletions:total}));
  }
}

var CS=function(x){return Object.assign({background:"#111118",border:"1px solid #1e293b",borderRadius:10,padding:"14px 16px"},x||{});};
var fld={width:"100%",padding:"10px 12px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,color:"#e2e8f0",fontSize:15,fontFamily:"inherit",boxSizing:"border-box"};
var lbl={fontSize:12,color:"#64748b",letterSpacing:1,textTransform:"uppercase",marginBottom:4,display:"block"};
function roFld(x){return Object.assign({},fld,{background:"#1e293b",color:"#94a3b8",display:"flex",alignItems:"center"},x||{});}

function Tag(props){return (<span style={{fontSize:12,padding:"2px 8px",borderRadius:4,background:props.color+"22",color:props.color,fontWeight:600}}>{props.label}</span>);}

// CHANGED: Reusable toggle switch component to replace checkboxes for enable/disable UI.
function ToggleSwitch(props){
  var checked=!!props.checked,onChange=props.onChange,label=props.label,size=props.size||"md";
  var dims=size==="sm"?{w:30,h:18,knob:14,pad:2}:{w:38,h:22,knob:18,pad:2};
  var labelColor=props.labelColor||(checked?"#86efac":"#64748b");
  var trackBg=checked?(props.activeColor||"#22c55e"):"#1e293b";
  var trackBorder=checked?(props.activeColor||"#22c55e"):"#334155";
  return (
    <label style={{display:"inline-flex",alignItems:"center",gap:8,cursor:"pointer",userSelect:"none",fontFamily:"inherit"}}>
      <span role="switch" aria-checked={checked} onClick={function(e){e.preventDefault();onChange(!checked);}} style={{position:"relative",width:dims.w,height:dims.h,background:trackBg,border:"1px solid "+trackBorder,borderRadius:dims.h/2,transition:"background 0.18s,border-color 0.18s",flexShrink:0,display:"inline-block",cursor:"pointer"}}>
        <span style={{position:"absolute",top:dims.pad-1,left:checked?(dims.w-dims.knob-dims.pad-1):(dims.pad-1),width:dims.knob,height:dims.knob,background:"#fff",borderRadius:"50%",transition:"left 0.18s",boxShadow:"0 1px 3px rgba(0,0,0,0.4)"}}/>
      </span>
      {label&&<span style={{fontSize:12,color:labelColor,fontWeight:600}}>{label}</span>}
    </label>
  );
}

function MultiDropdown(props){
  var options=props.options,selected=props.selected,onChange=props.onChange,negativeOptions=props.negativeOptions||[];
  var [open,setOpen]=useState(false);
  return (
    <div style={{position:"relative"}}>
      <label style={lbl}>{props.label}</label>
      <button onClick={function(){setOpen(function(o){return !o;});}} style={Object.assign({},fld,{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"})}>
        <span style={{color:selected.length>0?"#e2e8f0":"#64748b",fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"90%"}}>{selected.length>0?selected.join(", "):"Select..."}</span>
        <span style={{color:"#64748b",fontSize:13}}>v</span>
      </button>
      {open&&(
        <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#1e293b",border:"1px solid #334155",borderRadius:8,zIndex:200,overflow:"hidden",boxShadow:"0 8px 24px #00000066"}}>
          {options.map(function(opt){
            var sel=selected.indexOf(opt)>=0,neg=negativeOptions.indexOf(opt)>=0;
            return (
              <button key={opt} onClick={function(){onChange(sel?selected.filter(function(x){return x!==opt;}):[].concat(selected,[opt]));}} style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:sel?(neg?"#7f1d1d22":"#14532d22"):"transparent",border:"none",borderBottom:"1px solid #334155",color:sel?(neg?"#fca5a5":"#86efac"):"#cbd5e1",fontSize:14,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                <div style={{width:16,height:16,borderRadius:4,border:"2px solid "+(sel?(neg?"#ef4444":"#22c55e"):"#475569"),background:sel?(neg?"#ef4444":"#22c55e"):"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,color:"#fff",flexShrink:0}}>{sel?"v":""}</div>
                {opt}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function doRecalc(entries,exits,assetClassId,instrument,direction){
  var tc=0,rawCost=0;
  entries.forEach(function(en){var ec=parseFloat(en.contracts),ep=parseFloat(en.price);if(!isNaN(ec)&&!isNaN(ep)){tc+=ec;rawCost+=ec*ep;}});
  var avg=tc>0?rawCost/tc:NaN,pnl="",pctPnl="";
  var cls=ASSET_CLASSES[assetClassId]||ASSET_CLASSES.options;
  var baseMult=cls.multiplier||1;
  var futMult=(assetClassId==="futures"&&instrument)?getFuturesPointValue(instrument):1;
  var mult=assetClassId==="futures"?futMult:baseMult;
  var sign=(direction==="SHORT"||direction==="SELL")?-1:1;
  if(!isNaN(avg)&&exits.length>0){
    var tp=0,tv=0,txc=0;
    exits.forEach(function(ex){var ec=parseFloat(ex.contracts),ep=parseFloat(ex.price);if(!isNaN(ec)&&!isNaN(ep)){tp+=(ep-avg)*ec*mult*sign;tv+=ep*ec;txc+=ec;}});
    pnl=tp.toFixed(2);
    pctPnl=txc>0&&avg!==0?(((tv/txc-avg)/avg*100)*sign).toFixed(2):"0.00";
  }
  return {entries:entries,exits:exits,contracts:tc||"",positionSize:tc>0&&!isNaN(avg)?(rawCost*baseMult).toFixed(2):"",stopLoss:!isNaN(avg)?(avg*0.7).toFixed(2):"",pnl:pnl,pctPnl:pctPnl};
}
// CHANGED: Account balance = transfers + all journal P&L. Used for day-% calculation.
// CHANGED: Canonical account balance — transfers + journal P&L + today's live P&L (only if today isn't yet in journal). Use this everywhere to avoid mismatches.
// CHANGED: Effective R stops for a session. R values are not scaled by sizeFraction — 1R already represents session-scaled risk in tradeStatus.
function getSessionRStops(session){
  if(!session)return {lossR:-1,gainR:2.5};
  return {
    lossR:session.lossStopR!=null?parseFloat(session.lossStopR):-1,
    gainR:session.gainStopR!=null?parseFloat(session.gainStopR):2.5
  };
}
function computeAccountBalance(liveTotalPnL){
  try{
    var rows=loadJournalRows();
    var todayStrV=todayStr();
    var totPnL=0,inJ=false;
    rows.forEach(function(r){totPnL+=(parseFloat(r.pnl)||0);if(r.date===todayStrV)inJ=true;});
    if(!inJ&&liveTotalPnL!=null)totPnL+=parseFloat(liveTotalPnL)||0;
    return transferTotal(loadTransfers())+totPnL;
  }catch(e){return 0;}
}
function getAccountBalance(){
  try{
    var transfers=loadTransfers();
    var rows=loadJournalRows();
    var totalPnL=rows.reduce(function(s,e){return s+(parseFloat(e.pnl)||0);},0);
    return transferTotal(transfers)+totalPnL;
  }catch(e){return 0;}
}
// CHANGED: Account balance AT THE START of a given date (before that day's trades). Uses Date objects for cross-format compatibility.
function getAccountBalanceAtDate(dateStr){
  try{
    var target=new Date(dateStr);if(isNaN(target.getTime()))return 0;
    target.setHours(0,0,0,0);
    var transfers=loadTransfers();
    var rows=loadJournalRows();
    // Sum transfers BEFORE this date (transfers on the same day count as start-of-day capital).
    var tBal=(transfers||[]).reduce(function(s,t){
      if(!t.date)return s+(parseFloat(t.amount)||0);
      var d=new Date(t.date);if(isNaN(d.getTime()))return s;
      d.setHours(0,0,0,0);
      return d<=target?s+(parseFloat(t.amount)||0):s;
    },0);
    // Sum P&L from journal entries BEFORE this date.
    var pBal=rows.reduce(function(s,e){
      var d=new Date(e.date);if(isNaN(d.getTime()))return s;
      d.setHours(0,0,0,0);
      return d<target?s+(parseFloat(e.pnl)||0):s;
    },0);
    return tBal+pBal;
  }catch(e){return 0;}
}

function PnLChart(props){
  var trades=props.trades;
  var [hoverPnL,setHoverPnL]=useState(null);
  var [hoverX,setHoverX]=useState(null);
  var [hoverY,setHoverY]=useState(null);
  var [hoverTime,setHoverTime]=useState(null);
  var svgRef=useRef(null);
  var START=390,END=780,W=460,H=140,PL=40,PR=12,PT=12,PB=28;
  var chartW=W-PL-PR,chartH=H-PT-PB;
  function timeToMin(str){if(!str)return null;var m=str.match(/(\d+):(\d+)\s*(AM|PM)/i);if(!m)return null;var h=parseInt(m[1]),mn=parseInt(m[2]),pm=m[3].toUpperCase()==="PM";if(pm&&h!==12)h+=12;if(!pm&&h===12)h=0;return h*60+mn;}
  function minToTimeStr(mn){var h=Math.floor(mn/60),mi=Math.floor(mn%60),ampm=h>=12?"PM":"AM",h12=h%12||12;return h12+":"+(mi<10?"0"+mi:mi)+" "+ampm;}
  var points=[{min:START,pnl:0}];var cum=0;
  if(trades&&trades.length>0){
    trades.slice().filter(function(t){return timeToMin(t.time)!==null;}).sort(function(a,b){return timeToMin(a.time)-timeToMin(b.time);}).forEach(function(t){var mn=timeToMin(t.time);if(!mn)return;mn=Math.max(START,Math.min(END,mn));cum+=parseFloat(t.pnl)||0;points.push({min:mn,pnl:cum});});
  }
  points.push({min:END,pnl:cum});
  var vals=points.map(function(p){return p.pnl;});var minP=Math.min.apply(null,vals),maxP=Math.max.apply(null,vals);
  var rng=maxP-minP||1,pad=rng*0.15,yMin=minP-pad,yMax=maxP+pad,yRng=yMax-yMin||1;
  function xPx(mn){return PL+((mn-START)/(END-START))*chartW;}
  function yPx(v){return PT+(1-((v-yMin)/yRng))*chartH;}
  var zeroY=yPx(0),showZero=zeroY>=PT&&zeroY<=PT+chartH;
  var segs=[];
  for(var si=0;si<points.length-1;si++){
    var a=points[si],b=points[si+1];
    if((a.pnl>=0&&b.pnl>=0)||(a.pnl<0&&b.pnl<0)){segs.push({pts:[a,b],pos:a.pnl>=0});}
    else{var f=a.pnl/(a.pnl-b.pnl),cx={min:a.min+(b.min-a.min)*f,pnl:0};segs.push({pts:[a,cx],pos:a.pnl>=0});segs.push({pts:[cx,b],pos:b.pnl>=0});}
  }
  function linePath(pts){return pts.map(function(p,i){return (i===0?"M":"L")+xPx(p.min).toFixed(1)+","+yPx(p.pnl).toFixed(1);}).join(" ");}
  function fillPath(pts){var by=(showZero?zeroY:yPx(0)).toFixed(1);return linePath(pts)+" L"+xPx(pts[pts.length-1].min).toFixed(1)+","+by+" L"+xPx(pts[0].min).toFixed(1)+","+by+" Z";}
  function handleMove(clientX){
    var svg=svgRef.current;if(!svg)return;
    var rect=svg.getBoundingClientRect();
    var svgX=(clientX-rect.left)*(W/rect.width),chartX=svgX-PL;
    if(chartX<0||chartX>chartW){setHoverPnL(null);setHoverX(null);setHoverY(null);setHoverTime(null);return;}
    var mn=START+(chartX/chartW)*(END-START);
    var prev=points[0],nxt=points[points.length-1];
    for(var i=0;i<points.length-1;i++){if(points[i].min<=mn&&points[i+1].min>=mn){prev=points[i];nxt=points[i+1];break;}}
    var t2=nxt.min===prev.min?1:(mn-prev.min)/(nxt.min-prev.min);
    var pnl=prev.pnl+(nxt.pnl-prev.pnl)*t2;
    setHoverPnL(pnl);setHoverX(svgX);setHoverY(yPx(pnl));setHoverTime(minToTimeStr(mn));
  }
  if(!trades||trades.length===0)return null;
  var hc=hoverPnL===null?"#64748b":hoverPnL>=0?"#22c55e":"#ef4444";
  var xLabels=[{min:390,l:"6:30"},{min:480,l:"8:00"},{min:570,l:"9:30"},{min:660,l:"11:00"},{min:750,l:"12:30"},{min:780,l:"1:00"}];
  var yTicks=[Math.round(yMin+yRng*0.1),Math.round(yMin+yRng*0.5),Math.round(yMin+yRng*0.9)];
  return (
    <div style={{marginTop:12,background:"#0a0a0f",borderRadius:8,padding:"8px 4px 4px"}}>
      <div style={{fontSize:12,color:"#64748b",letterSpacing:1,textTransform:"uppercase",marginBottom:4,paddingLeft:PL+"px",display:"flex",alignItems:"center",gap:8}}>
        P&L Over Session
        {hoverPnL!==null&&<span style={{fontWeight:700,color:hc,fontSize:13}}>{hoverPnL>=0?"+":""}{$fmt(hoverPnL)}</span>}
      </div>
      <svg ref={svgRef} width="100%" viewBox={"0 0 "+W+" "+H} style={{overflow:"visible",cursor:"crosshair",userSelect:"none"}}
        onMouseMove={function(e){handleMove(e.clientX);}} onMouseLeave={function(){setHoverPnL(null);setHoverX(null);setHoverY(null);setHoverTime(null);}}
        onTouchMove={function(e){e.preventDefault();if(e.touches.length)handleMove(e.touches[0].clientX);}} onTouchEnd={function(){setHoverPnL(null);setHoverX(null);setHoverY(null);setHoverTime(null);}}>
        {yTicks.map(function(v,i){var y=yPx(v);if(y<PT||y>PT+chartH)return null;return <line key={i} x1={PL} y1={y} x2={PL+chartW} y2={y} stroke="#1e293b" strokeWidth="1"/>;})}
        {showZero&&<line x1={PL} y1={zeroY} x2={PL+chartW} y2={zeroY} stroke="#334155" strokeWidth="1" strokeDasharray="3,3"/>}
        {segs.map(function(s,i){return <path key={"f"+i} d={fillPath(s.pts)} fill={s.pos?"#22c55e22":"#ef444433"}/>;})}
        {segs.map(function(s,i){return <path key={"l"+i} d={linePath(s.pts)} fill="none" stroke={s.pos?"#22c55e":"#ef4444"} strokeWidth="2" strokeLinejoin="round"/>;})}
        {points.slice(1,-1).map(function(p,i){return <circle key={i} cx={xPx(p.min)} cy={yPx(p.pnl)} r="3" fill={p.pnl>=0?"#22c55e":"#ef4444"} stroke="#0a0a0f" strokeWidth="1.5"/>;})}
        {yTicks.map(function(v,i){var y=yPx(v);if(y<PT||y>PT+chartH)return null;if(HIDE_DOLLAR_PNL)return null;return <text key={i} x={PL-4} y={y+4} textAnchor="end" fontSize="8" fill="#475569">{v>=0?"+$"+v:"-$"+Math.abs(v)}</text>;})}
        {/* CHANGED: When hovering, hide the static x-axis tick labels (they'd overlap with the cursor time label). */}
        {hoverX===null&&xLabels.map(function(xl){return <text key={xl.min} x={xPx(xl.min)} y={PT+chartH+16} textAnchor="middle" fontSize="8" fill="#475569">{xl.l}</text>;})}
        <line x1={PL} y1={PT} x2={PL} y2={PT+chartH} stroke="#1e293b" strokeWidth="1"/>
        <line x1={PL} y1={PT+chartH} x2={PL+chartW} y2={PT+chartH} stroke="#1e293b" strokeWidth="1"/>
        {hoverX!==null&&<g><line x1={hoverX} y1={PT} x2={hoverX} y2={PT+chartH} stroke="#475569" strokeWidth="1" strokeDasharray="3,3"/><circle cx={hoverX} cy={hoverY} r="5" fill={hc} stroke="#0a0a0f" strokeWidth="2"/>{/* CHANGED: Time label pinned under the cursor line at the bottom. */}{hoverTime&&<text x={hoverX} y={PT+chartH+16} textAnchor="middle" fontSize="9" fontWeight="700" fill="#cbd5e1">{hoverTime}</text>}</g>}
      </svg>
    </div>
  );
}

function DailyPnLBar(props){
  var entries=props.entries||[];
  var [hoverIdx,setHoverIdx]=useState(null);
  if(entries.length===0)return null;
  var sortedRaw=entries.slice().sort(function(a,b){return new Date(a.date)-new Date(b.date);});
  // CHANGED: When the range spans > ~60 days, aggregate by week (Sunday-start) so the chart stays readable.
  var spanMs=new Date(sortedRaw[sortedRaw.length-1].date)-new Date(sortedRaw[0].date);
  var weekly=spanMs>60*24*3600*1000;
  var sorted;
  if(weekly){
    var buckets={};
    sortedRaw.forEach(function(e){
      var d=new Date(e.date);d.setHours(0,0,0,0);
      d.setDate(d.getDate()-d.getDay()); // Sunday of this week
      var k=d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();
      if(!buckets[k])buckets[k]={date:k,sortKey:d.getTime(),pnl:0,_rep:e.date};
      buckets[k].pnl+=parseFloat(e.pnl)||0;
    });
    sorted=Object.keys(buckets).map(function(k){return buckets[k];}).sort(function(a,b){return a.sortKey-b.sortKey;});
  }else{
    sorted=sortedRaw;
  }
  var pnls=sorted.map(function(e){return parseFloat(e.pnl)||0;});
  // CHANGED: Compute % per day (relative to that day's account balance) so hide-$ can show meaningful percentages.
  var pcts=sorted.map(function(e){var sb=0;try{sb=getAccountBalanceAtDate(e.date);}catch(x){}return sb>0?((parseFloat(e.pnl)||0)/sb*100):0;});
  // CHANGED: Compute summary stats for the dashboard-style header above the chart.
  var greenN=pnls.filter(function(v){return v>0;}).length;
  var redN=pnls.filter(function(v){return v<0;}).length;
  var flatN=pnls.filter(function(v){return v===0;}).length;
  var bestDay=Math.max.apply(null,pnls);
  var worstDay=Math.min.apply(null,pnls);
  var avgDay=pnls.reduce(function(s,v){return s+v;},0)/pnls.length;
  var bestPct=Math.max.apply(null,pcts);
  var worstPct=Math.min.apply(null,pcts);
  var avgPct=pcts.reduce(function(s,v){return s+v;},0)/pcts.length;
  // CHANGED: fmt now takes both $ and % so it can return the % when dollars are hidden.
  var fmt=function(n,pct){if(HIDE_DOLLAR_PNL)return (pct>=0?"+":"")+pct.toFixed(2)+"%";return (n>=0?"+":"-")+"$"+Math.abs(n).toFixed(0);};
  // CHANGED: When dollars are hidden, scale bar heights by per-day % so the visible bar size
  // matches the unit shown in the tooltip. Otherwise a small-$-but-big-% day got squashed into
  // an invisible sliver by a single large-$ outlier.
  var vals=HIDE_DOLLAR_PNL?pcts:pnls;
  var maxAbs=Math.max.apply(null,vals.map(function(v){return Math.abs(v);}))||1;
  // CHANGED: PL (left padding) was reserved for $-axis tick labels. When dollars are hidden,
  // those labels don't render, so the reserved space showed as a blank gutter on the chart's
  // left side. Collapse PL in that case so the chart fills its container.
  var W=460,H=160,PL=HIDE_DOLLAR_PNL?8:44,PR=12,PT=12,PB=32,chartW=W-PL-PR,chartH=H-PT-PB;
  var barW=Math.max(4,Math.floor((chartW/sorted.length)*0.7)),gap=chartW/sorted.length,zeroY=PT+chartH/2;
  function barX(i){return PL+i*gap+gap/2-barW/2;}
  function barH(pnl,pct){var v=HIDE_DOLLAR_PNL?pct:pnl;return Math.abs(v)/maxAbs*(chartH/2-4);}
  function barY(pnl,pct){return (HIDE_DOLLAR_PNL?pct:pnl)>=0?zeroY-barH(pnl,pct):zeroY;}
  function fmtDate(ds){var d=new Date(ds);return (d.getMonth()+1)+"/"+(d.getDate());}
  function fmtPnl(v){return (v>=0?"+":"")+"$"+v.toFixed(2);}
  var yTicks=[-maxAbs,0,maxAbs].map(function(v){return Math.round(v);});
  function onMouseMove(e){
    var rect=e.currentTarget.getBoundingClientRect();
    var svgX=(e.clientX-rect.left)*(W/rect.width);
    var nearest=null,nearestDist=Infinity;
    for(var i=0;i<sorted.length;i++){
      var cx=PL+i*gap+gap/2;
      var dist=Math.abs(svgX-cx);
      if(dist<nearestDist){nearestDist=dist;nearest=i;}
    }
    if(svgX>=PL&&svgX<=PL+chartW)setHoverIdx(nearest);
    else setHoverIdx(null);
  }
  return (
    <div>
      {/* CHANGED: Dashboard-style header strip — green/red day counts and best/worst/avg cells. */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:8}}>
        <div style={{padding:"6px 9px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:6}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Green / Red</div>
          <div style={{fontSize:12,fontWeight:700,marginTop:2,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}><span style={{color:"#22c55e"}}>{greenN}</span><span style={{color:"#94a3b8",fontWeight:500}}> / </span><span style={{color:"#ef4444"}}>{redN}</span>{flatN>0&&<span style={{color:"#94a3b8",marginLeft:5,fontWeight:500}}>· {flatN} flat</span>}</div>
        </div>
        <div style={{padding:"6px 9px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:6}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Best / Worst</div>
          <div style={{fontSize:11,fontWeight:700,marginTop:2,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}><span style={{color:"#22c55e"}}>{fmt(bestDay,bestPct)}</span><span style={{color:"#94a3b8"}}> / </span><span style={{color:"#ef4444"}}>{fmt(worstDay,worstPct)}</span></div>
        </div>
        <div style={{padding:"6px 9px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:6}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Avg / Day</div>
          <div style={{fontSize:12,fontWeight:700,marginTop:2,color:avgDay>=0?"#22c55e":"#ef4444",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{fmt(avgDay,avgPct)}</div>
        </div>
      </div>
      <div style={{background:"#0a0a0f",borderRadius:8,padding:"4px 0 0",border:"1px solid #1e293b"}}>
      <svg width="100%" viewBox={"0 0 "+W+" "+H} style={{overflow:"visible",userSelect:"none"}}
        onMouseMove={onMouseMove}
        onMouseLeave={function(){setHoverIdx(null);}}>
        {yTicks.map(function(v,i){var y=zeroY-(v/maxAbs)*(chartH/2);return <g key={i}><line x1={PL} y1={y} x2={PL+chartW} y2={y} stroke={v===0?"#334155":"#1e293b"} strokeWidth="1" strokeDasharray={v===0?"":"3,3"}/>{!HIDE_DOLLAR_PNL&&<text x={PL-4} y={y+4} textAnchor="end" fontSize="8" fill="#94a3b8">{v>=0?"+$"+Math.abs(v):"-$"+Math.abs(v)}</text>}</g>;})}
        {sorted.map(function(e,i){
          var pnl=parseFloat(e.pnl)||0,pct=pcts[i],bx=barX(i),bh=barH(pnl,pct),by=barY(pnl,pct),isHov=hoverIdx===i;
          var color=pnl>=0?"#22c55e":"#ef4444",hc2=pnl>=0?"#4ade80":"#f87171";
          return (
            <g key={i}>
              {/* Visible bar */}
              <rect x={bx} y={by} width={barW} height={Math.max(bh,1)} fill={isHov?hc2:color} rx="2" style={{transition:"fill 0.1s"}}/>
              {/* CHANGED: Vertical hover line on active column */}
              {isHov&&<line x1={bx+barW/2} y1={PT} x2={bx+barW/2} y2={PT+chartH} stroke="#334155" strokeWidth="1" strokeDasharray="3,2"/>}
              {/* Date label */}
              {(sorted.length<=10||(i%(Math.ceil(sorted.length/8))===0))&&<text x={bx+barW/2} y={PT+chartH+16} textAnchor="middle" fontSize="8" fill={isHov?"#e2e8f0":"#94a3b8"}>{fmtDate(e.date)}</text>}
            </g>
          );
        })}
        {/* CHANGED: Tooltip moved OUT of the per-bar loop and rendered last so later bars can't
           paint over it. Also given an opaque fill + border so it's readable against any bar. */}
        {hoverIdx!=null&&(function(){
          var e=sorted[hoverIdx];if(!e)return null;
          var pnl=parseFloat(e.pnl)||0,bx=barX(hoverIdx),bh=barH(pnl,pcts[hoverIdx]),by=barY(pnl,pcts[hoverIdx]);
          var color=pnl>=0?"#22c55e":"#ef4444";
          var tx=bx+barW/2,ty=pnl>=0?by-6:by+bh+14;
          var dateStr=fmtDate(e.date),pnlStr=HIDE_DOLLAR_PNL?((function(){var sb=getAccountBalanceAtDate(e.date);var p=sb>0?(pnl/sb*100):0;return (p>=0?"+":"")+p.toFixed(2)+"%";})()):(fmtPnl(pnl));
          var trades=(e.trades||[]).length;
          var label=dateStr+" · "+pnlStr+(trades>0?" · "+trades+"t":"");
          var tw=label.length*5.5+16;
          var tx2=Math.max(PL+tw/2,Math.min(PL+chartW-tw/2,tx));
          var ty2=pnl>=0?Math.max(PT+14,ty):Math.min(PT+chartH-4,ty);
          return (
            <g style={{pointerEvents:"none"}}>
              <rect x={tx2-tw/2} y={ty2-13} width={tw} height={18} fill="#0f172a" stroke="#334155" strokeWidth="0.75" rx="4" style={{filter:"drop-shadow(0 2px 6px rgba(0,0,0,0.7))"}}/>
              <text x={tx2} y={ty2} textAnchor="middle" fontSize="9" fontWeight="700" fill={color}>{label}</text>
            </g>
          );
        })()}
        <line x1={PL} y1={PT} x2={PL} y2={PT+chartH} stroke="#1e293b" strokeWidth="1"/>
        <line x1={PL} y1={PT+chartH} x2={PL+chartW} y2={PT+chartH} stroke="#1e293b" strokeWidth="1"/>
      </svg>
      </div>
    </div>
  );
}

function MonthYearPicker(props){
  var year=props.year,month=props.month,onChange=props.onChange;
  var [draftYear,setDraftYear]=useState(year);
  return (
    <div style={{background:"#0a0a0f",border:"1px solid #4338ca",borderRadius:8,padding:"12px",marginBottom:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <button onClick={function(){setDraftYear(function(y){return y-1;});}} style={{background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"4px 10px"}}>‹</button>
        <span style={{fontSize:16,fontWeight:700,color:"#a5b4fc"}}>{draftYear}</span>
        <button onClick={function(){setDraftYear(function(y){return y+1;});}} style={{background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"4px 10px"}}>›</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
        {MONTH_NAMES.map(function(m,i){var sel=draftYear===year&&i===month;return <button key={m} onClick={function(){onChange(draftYear,i);}} style={{padding:"8px 0",background:sel?"#4f46e5":"#1e293b",border:"none",borderRadius:5,color:sel?"#fff":"#cbd5e1",fontSize:13,cursor:"pointer",fontFamily:"inherit",fontWeight:sel?700:500}}>{m.slice(0,3)}</button>;})}
      </div>
    </div>
  );
}

// CHANGED: Unified calendar legend — 2-column grid for consistent alignment, includes
// "Discipline broken" entry with the D badge marker used on cells.
function CalendarLegend(){
  var items=[
    {sw:<div style={{width:10,height:10,borderRadius:2,background:"#14532d",border:"1px solid #166534"}}/>,label:"Green day"},
    {sw:<div style={{width:10,height:10,borderRadius:2,background:"#7f1d1d",border:"1px solid #991b1b"}}/>,label:"Red day"},
    {sw:<div style={{width:10,height:10,borderRadius:2,background:"#1e1b4b",border:"1px solid #4338ca"}}/>,label:"Today"},
    {sw:<div style={{width:10,height:10,borderRadius:2,background:"#1c1408",border:"1.5px dashed #a16207"}}/>,label:"No-trade"},
    {sw:<div style={{width:10,height:10,borderRadius:2,background:"#2a1d0a",border:"1px solid #713f12"}}/>,label:"Holiday"},
    {sw:<div style={{width:8,height:8,borderRadius:"50%",background:"#f59e0b"}}/>,label:"Early close"},
    {sw:<div style={{fontSize:8,fontWeight:800,color:"#fff",background:"#ef4444",borderRadius:3,padding:"0 3px",lineHeight:"11px",letterSpacing:0.3}}>D</div>,label:"Discipline broken"}
  ];
  return (
    <div style={{marginTop:12,paddingTop:10,borderTop:"1px solid #1e293b",display:"grid",gridTemplateColumns:"1fr 1fr",rowGap:6,columnGap:14}}>
      {items.map(function(it,i){return (
        <div key={i} style={{display:"flex",alignItems:"center",gap:7,minWidth:0}}>
          <div style={{width:14,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{it.sw}</div>
          <span style={{fontSize:11,color:"#94a3b8",lineHeight:1.3}}>{it.label}</span>
        </div>
      );})}
    </div>
  );
}

function CalendarGrid(props){
  var sessionMap=props.sessionMap,todayDateStr=props.todayDateStr,selectedDate=props.selectedDate,onSelect=props.onSelect;
  var now=getPT();
  var [calYear,setCalYear]=useState(now.getFullYear());
  var [calMonth,setCalMonth]=useState(now.getMonth());
  var [showPicker,setShowPicker]=useState(false);
  function moveMonth(delta){var m=calMonth+delta;var y=calYear;if(m<0){m=11;y--;}if(m>11){m=0;y++;}setCalMonth(m);setCalYear(y);}
  // CHANGED: Drag-to-swipe months — mouse or touch. Threshold 60px; right drag = prev month, left = next.
  var dragRef=React.useRef({startX:null,dragging:false,suppressClick:false});
  function dragStart(x){dragRef.current.startX=x;dragRef.current.dragging=true;dragRef.current.suppressClick=false;}
  function dragMove(x){if(!dragRef.current.dragging||dragRef.current.startX==null)return;var d=x-dragRef.current.startX;if(Math.abs(d)>4)dragRef.current.suppressClick=true;}
  function dragEnd(x){if(!dragRef.current.dragging)return;var d=(x!=null?x-dragRef.current.startX:0);dragRef.current.dragging=false;dragRef.current.startX=null;if(Math.abs(d)>60)moveMonth(d>0?-1:1);}
  function onCellClickCapture(e){if(dragRef.current.suppressClick){e.preventDefault();e.stopPropagation();dragRef.current.suppressClick=false;}}
  var firstDay=new Date(calYear,calMonth,1).getDay();
  var daysInMonth=new Date(calYear,calMonth+1,0).getDate();
  var weeks=[];var cur=[];
  for(var i=0;i<firstDay;i++)cur.push(null);
  for(var d=1;d<=daysInMonth;d++){cur.push(d);if(cur.length===7){weeks.push(cur);cur=[];}}
  if(cur.length>0){while(cur.length<7)cur.push(null);weeks.push(cur);}
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <button onClick={function(){moveMonth(-1);}} style={{background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"4px 10px"}}>‹</button>
        <button onClick={function(){setShowPicker(function(o){return !o;});}} style={{background:"none",border:"none",fontSize:15,fontWeight:700,color:"#e2e8f0",cursor:"pointer",fontFamily:"inherit"}}>{MONTH_NAMES[calMonth]} {calYear}</button>
        <button onClick={function(){moveMonth(1);}} style={{background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",padding:"4px 10px"}}>›</button>
      </div>
      {showPicker&&<MonthYearPicker year={calYear} month={calMonth} onChange={function(y,m){setCalYear(y);setCalMonth(m);setShowPicker(false);}}/>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,marginBottom:6}}>
        {["S","M","T","W","T","F","S"].map(function(c,i){return <div key={i} style={{textAlign:"center",fontSize:11,color:"#475569",fontWeight:700}}>{c}</div>;})}
      </div>
      <div onMouseDown={function(e){dragStart(e.clientX);}} onMouseMove={function(e){dragMove(e.clientX);}} onMouseUp={function(e){dragEnd(e.clientX);}} onMouseLeave={function(){dragEnd(null);}} onTouchStart={function(e){if(e.touches[0])dragStart(e.touches[0].clientX);}} onTouchMove={function(e){if(e.touches[0])dragMove(e.touches[0].clientX);}} onTouchEnd={function(e){var tx=e.changedTouches&&e.changedTouches[0]?e.changedTouches[0].clientX:null;dragEnd(tx);}} onClickCapture={onCellClickCapture} style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3,cursor:"grab",userSelect:"none"}}>
        {weeks.flat().map(function(d,i){
          if(!d)return <div key={i} style={{height:34}}/>;
          var ds=(calMonth+1)+"/"+d+"/"+calYear;
          var dayData=sessionMap[ds];
          var pnl=dayData?dayData.pnl:null;
          var dayRiskMax=dayData?dayData.riskMax:0;
          var isToday=ds===todayDateStr;
          var isSelected=ds===selectedDate;
          var holiday=MARKET_HOLIDAYS[ds];
          var earlyClose=EARLY_CLOSE_DAYS[ds];
          var bg="#0a0a0f",bd="#1e293b",col="#94a3b8";
          if(holiday){bg="#2a1d0a";bd="#713f12";col="#fbbf24";}
          if(pnl!=null&&pnl!==0){if(pnl>0){bg="#14532d";bd="#166534";col="#86efac";}else{bg="#7f1d1d";bd="#991b1b";col="#fca5a5";}}
          // CHANGED: No-Trade Day — explicitly logged. Made visually unmistakable: amber-tinted cell,
          // dashed border (signals "intentionally skipped"), brighter label, and a ⊘ icon.
          var isNoTrade=!!(dayData&&dayData.noTradeDay&&dayData.tradeCount===0);
          var noTradeBorderStyle="solid";
          if(isNoTrade){bg="#1c1408";bd="#a16207";col="#fcd34d";noTradeBorderStyle="dashed";}
          if(isToday){bg="#1e1b4b";bd="#4338ca";col="#a5b4fc";noTradeBorderStyle="solid";}
          if(isSelected){bd="#818cf8";}
          return (
            <button key={i} onClick={function(){onSelect(ds);}} style={{height:46,background:bg,border:(isNoTrade?"1.5px ":"1px ")+noTradeBorderStyle+" "+bd,borderRadius:5,color:col,fontSize:13,fontWeight:isToday||isSelected||isNoTrade?700:500,cursor:"pointer",fontFamily:"inherit",position:"relative",padding:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2}} title={holiday||(isNoTrade?"No-trade day (deliberately sat out)":(pnl!=null?(pnl>=0?"+":"")+"$"+pnl.toFixed(0):""))}>
              <span style={{lineHeight:1}}>{d}</span>
              {pnl!=null&&dayData&&dayData.tradeCount>0&&(HIDE_DOLLAR_PNL?(dayRiskMax>0&&<span style={{fontSize:9,color:col,fontWeight:600,fontVariantNumeric:"tabular-nums",lineHeight:1}}>{(pnl/dayRiskMax>=0?"+":"")+(pnl/dayRiskMax).toFixed(1)}R</span>):<span style={{fontSize:9,color:col,fontWeight:600,fontVariantNumeric:"tabular-nums",lineHeight:1}}>{(pnl>=0?"+$":"-$")+Math.abs(pnl).toFixed(0)}</span>)}
              {isNoTrade&&!isToday&&<span style={{fontSize:9,color:"#fbbf24",fontWeight:800,letterSpacing:0.3,lineHeight:1}}>⊘ NT</span>}
              {earlyClose&&<div style={{position:"absolute",top:1,right:2,width:4,height:4,borderRadius:"50%",background:"#f59e0b"}}/>}
              {/* CHANGED: Discipline-lock marker — small "D" badge in top-left corner when day's discipline score fell below threshold. */}
              {dayData&&dayData.wasLocked&&<div style={{position:"absolute",top:1,left:2,fontSize:8,fontWeight:800,color:"#fff",background:"#ef4444",borderRadius:3,padding:"0 3px",lineHeight:"11px",letterSpacing:0.3}} title="Discipline lock triggered">D</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DashboardCalendar(props){
  // CHANGED: Persist open/closed across re-renders so a resync (which can re-mount widgets) doesn't
  // collapse the user's chosen view.
  var [open,setOpen]=useState(function(){try{var v=localStorage.getItem("tf-dash-cal-open");return v===null?(props.defaultOpen||false):v==="1";}catch(e){return props.defaultOpen||false;}});
  useEffect(function(){try{localStorage.setItem("tf-dash-cal-open",open?"1":"0");}catch(e){}},[open]);
  var sessionMap=buildSessionMap(props.totalPnL,props.riskMax,(props.todayTrades||[]).filter(function(t){return t&&t.status!=="open";}).length);
  var todayDateStr=todayStr();
  // CHANGED: Week strip starts on Sunday to match the calendar grid (S M T W T F S).
  var calNow=getPT();
  var calDow=calNow.getDay();
  // Sunday = 0; offset is just -dow.
  var weekStartDate=new Date(calNow.getFullYear(),calNow.getMonth(),calNow.getDate()-calDow);
  var weekDays=[];
  for(var wi=0;wi<7;wi++){
    var wd=new Date(weekStartDate);wd.setDate(weekStartDate.getDate()+wi);
    var wds=(wd.getMonth()+1)+"/"+wd.getDate()+"/"+wd.getFullYear();
    var dayData=sessionMap[wds];
    weekDays.push({date:wd,ds:wds,isToday:wds===todayDateStr,pnl:dayData?dayData.pnl:null,riskMax:dayData?dayData.riskMax:0,tradeCount:dayData?dayData.tradeCount:0,noTradeDay:!!(dayData&&dayData.noTradeDay&&dayData.tradeCount===0),wasLocked:!!(dayData&&dayData.wasLocked),holiday:MARKET_HOLIDAYS[wds]});
  }
  var dayLabels=["S","M","T","W","T","F","S"];
  // Calculate week's total PnL and R-value.
  // CHANGED: weekR is the SUM of each trading day's R (1.7R + 0.8R = 2.5R), not totalPnL / totalRisk
  // which averages instead of sums. Empty/non-trading days contribute 0. This matches how traders
  // intuitively read weekly R — each winning day adds, each losing day subtracts.
  var weekPnL=weekDays.reduce(function(sum,d){return sum+(d.pnl||0);},0);
  var weekRiskTotal=weekDays.reduce(function(sum,d){return sum+((d.tradeCount>0&&d.riskMax>0)?d.riskMax:0);},0);
  var weekR=weekDays.reduce(function(sum,d){return sum+((d.tradeCount>0&&d.riskMax>0)?(d.pnl/d.riskMax):0);},0);
  var weekRiskMax=weekRiskTotal; // kept for the display gating condition below
  var weekRColor=weekR>=0?"#86efac":"#fca5a5";
  return (
    <div style={CS({marginBottom:16,padding:0,overflow:"hidden"})}>
      <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",padding:"12px 18px 8px",textAlign:"left"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>{open?"Calendar":"This Week"}</span>
          {!open&&weekRiskMax>0&&weekDays.some(function(d){return d.tradeCount>0;})&&<span style={{fontSize:12,fontWeight:700,color:weekRColor,fontVariantNumeric:"tabular-nums"}}>{(weekR>=0?"+":"")+weekR.toFixed(1)}R</span>}
        </div>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{display:"inline-block",verticalAlign:"middle",transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {/* CHANGED: Week strip hidden when full calendar is expanded (it's redundant). */}
      {!open&&(
        <div style={{padding:"0 14px 14px"}}>
          {/* CHANGED: Day-of-week header row above the strip, matching the expanded calendar. */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:5,marginBottom:4}}>
            {dayLabels.map(function(dl,i){return <div key={i} style={{textAlign:"center",fontSize:10,color:"#64748b",letterSpacing:0.5,fontWeight:600,textTransform:"uppercase"}}>{dl}</div>;})}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:5}}>
            {weekDays.map(function(d,i){
              var pnl=d.pnl;
              var dayRiskMax=d.riskMax;
              var bg="#0a0a0f",bd="#1e293b",col="#94a3b8";
              if(d.holiday){bg="#2a1d0a";bd="#713f12";col="#fbbf24";}
              if(pnl!=null&&pnl!==0){if(pnl>0){bg="#14532d";bd="#166534";col="#86efac";}else{bg="#7f1d1d";bd="#991b1b";col="#fca5a5";}}
              var ntStyle="solid";
              if(d.noTradeDay){bg="#1c1408";bd="#a16207";col="#fcd34d";ntStyle="dashed";}
              if(d.isToday){bd="#818cf8";ntStyle="solid";}
              return (
                <button key={i} onClick={function(){if(props.onSelectDate)props.onSelectDate(d.ds);}} style={{padding:"9px 0 6px",background:bg,border:(d.noTradeDay?"1.5px ":"1px ")+ntStyle+" "+bd,borderRadius:6,cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",alignItems:"center",gap:2,minHeight:50,position:"relative"}} title={d.holiday||(d.noTradeDay?"No-trade day (deliberately sat out)":(pnl!=null?(HIDE_DOLLAR_PNL?"":(pnl>=0?"+$":"-$")+Math.abs(pnl).toFixed(2)):""))}>
                  {d.wasLocked&&<div style={{position:"absolute",top:2,left:3,fontSize:8,fontWeight:800,color:"#fff",background:"#ef4444",borderRadius:3,padding:"0 3px",lineHeight:"11px",letterSpacing:0.3}} title="Discipline lock triggered">D</div>}
                  {/* CHANGED: Inner letter removed — the column header above takes its place. */}
                  <span style={{fontSize:17,color:col,fontWeight:d.isToday?700:600,lineHeight:1}}>{d.date.getDate()}</span>
                  {d.noTradeDay?(
                    <span style={{fontSize:10,color:"#fbbf24",fontWeight:800,letterSpacing:0.3,lineHeight:1,marginTop:2}}>⊘ NT</span>
                  ):pnl!=null&&(d.tradeCount>0||pnl!==0)?(
                    HIDE_DOLLAR_PNL?(
                      dayRiskMax>0?<span style={{fontSize:10,color:col,fontWeight:600,fontVariantNumeric:"tabular-nums",lineHeight:1,marginTop:2}}>{(pnl/dayRiskMax>=0?"+":"")+(pnl/dayRiskMax).toFixed(1)}R</span>:<span style={{fontSize:10,lineHeight:1,marginTop:2,color:"transparent"}}>·</span>
                    ):<span style={{fontSize:10,color:col,fontWeight:600,fontVariantNumeric:"tabular-nums",lineHeight:1,marginTop:2}}>{(pnl>=0?"+$":"-$")+Math.abs(pnl).toFixed(0)}</span>
                  ):<span style={{fontSize:10,lineHeight:1,marginTop:2,color:"transparent"}}>·</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {open&&(
        <div style={{padding:"4px 18px 14px",borderTop:"1px solid #1e293b"}}>
          <CalendarGrid sessionMap={sessionMap} todayDateStr={todayDateStr} selectedDate={null} onSelect={function(d){if(props.onSelectDate)props.onSelectDate(d);}}/>
          <CalendarLegend/>
        </div>
      )}
    </div>
  );
}

function CalendarPicker(props){
  var selectedDate=props.selectedDate,onSelect=props.onSelect,onClose=props.onClose,todayPnL=props.todayPnL;
  var riskMax=parseFloat(props.riskMax)||0;
  var todayCount=(props.todayTrades||[]).filter(function(t){return t&&t.status!=="open";}).length;
  var sessionMap=buildSessionMap(todayPnL,riskMax,todayCount),todayDateStr=todayStr();
  return (
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",background:"#00000088"}} onClick={onClose}>
      <div style={{background:"#111118",border:"1px solid #334155",borderRadius:14,padding:"16px 16px 12px",width:380,maxWidth:"94vw",maxHeight:"92vh",overflowY:"auto",boxShadow:"0 16px 48px #000000bb"}} onClick={function(e){e.stopPropagation();}}>
        <button onClick={function(){onSelect(todayDateStr);}} style={{width:"100%",padding:"8px",background:"#1e1b4b",border:"1px solid #4338ca",borderRadius:8,color:"#a5b4fc",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginBottom:10}}>Today — {todayDateStr}</button>
        <CalendarGrid sessionMap={sessionMap} todayDateStr={todayDateStr} selectedDate={selectedDate} onSelect={onSelect}/>
        <CalendarLegend/>
      </div>
    </div>
  );
}

// CHANGED: ChecklistPanel now reads items from settings (loadChecklistItems).
function ChecklistPanel(props){
  var state=props.state,setState=props.setState,settings=props.settings,preCheckComplete=props.preCheckComplete;
  var [open,setOpen]=useState(false);
  var [reloadKey,setReloadKey]=useState(0);
  var allItems=loadChecklistItems();
  // CHANGED: Conditions items are shown in the trade log banner, not here.
  var items=allItems.filter(function(it){return (it.cat||"").toLowerCase()!=="conditions";});
  // Re-load when reloadKey prop changes (settings updated)
  useEffect(function(){setReloadKey(function(k){return k+1;});},[props.checklistVersion]);
  var totalCount=items.length;
  var passCount=0;
  items.forEach(function(it){
    var v=!!state.preChecklist[it.key];
    if(it.inverted){if(!v)passCount++;}
    else {if(v)passCount++;}
  });
  return (
    <div style={{marginBottom:16}}>
      <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:"#111118",border:"1px solid "+(preCheckComplete?"#166534":"#4338ca"),borderRadius:open?"10px 10px 0 0":"10px",cursor:"pointer",fontFamily:"inherit"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:15,fontWeight:700,color:preCheckComplete?"#86efac":"#a5b4fc"}}>Pre-Market Checklist</span>
          <span style={{fontSize:13,color:"#64748b"}}>{passCount}/{totalCount}</span>
        </div>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{display:"inline-block",verticalAlign:"middle",transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open&&(
        <div style={{background:"#0a0a0f",border:"1px solid "+(preCheckComplete?"#166534":"#4338ca"),borderTop:"none",borderRadius:"0 0 10px 10px",padding:"14px 16px"}}>
          {items.map(function(item,i,arr){
            var showHeader=i===0||arr[i-1].cat!==item.cat,checked=!!state.preChecklist[item.key];
            var inv=!!item.inverted;
            var showWarn=inv&&checked;
            var showOK=(!inv&&checked)||(inv&&!checked);
            var bg=showWarn?"#2a0f0f":(showOK&&!inv?"#0f2a1c":"#111118");
            var bd=showWarn?"#7f1d1d":(showOK&&!inv?"#166534":"#1e293b");
            var boxBg=showWarn?"#ef4444":(showOK&&!inv?"#22c55e":"transparent");
            var boxBorder=showWarn?"#ef4444":(showOK&&!inv?"#22c55e":"#475569");
            var labelColor=showWarn?"#fca5a5":(showOK&&!inv?"#86efac":"#cbd5e1");
            // Substitute position max in label if applicable
            var label=item.label;
            if(item.key==="positionSized"&&settings&&settings.positionMin&&settings.positionMax){
              label=label+" ($"+settings.positionMin+"-$"+settings.positionMax+")";
            }
            return (
              <div key={item.key+":"+i}>
                {showHeader&&<div style={{fontSize:12,color:preCheckComplete?"#22c55e":"#6366f1",letterSpacing:1.5,textTransform:"uppercase",marginTop:i>0?12:0,marginBottom:6,fontWeight:600}}>{item.cat}</div>}
                <button onClick={function(){setState(function(s){var c=Object.assign({},s.preChecklist);c[item.key]=!c[item.key];return Object.assign({},s,{preChecklist:c});});}} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"10px 12px",background:bg,border:"1px solid "+bd,borderRadius:8,marginBottom:5,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                  <div style={{width:20,height:20,borderRadius:5,border:"2px solid "+boxBorder,background:boxBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:"#fff",flexShrink:0}}>{checked?(inv?"!":"v"):""}</div>
                  <span style={{fontSize:14,color:labelColor,fontWeight:500}}>{label}</span>
                </button>
              </div>
            );
          })}
          {/* CHANGED: When the checklist is complete, the Go-to-Journal button appears inside the panel banner. */}
          {preCheckComplete&&props.onNavigateToJournal&&(
            <button onClick={function(){props.onNavigateToJournal();}} style={{width:"100%",marginTop:10,padding:"12px",background:"linear-gradient(135deg,#16a34a,#22c55e)",color:"#fff",border:"none",borderRadius:8,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>✓ Checklist complete — Go to Journal →</button>
          )}
        </div>
      )}
    </div>
  );
}

function SessionStrategy(props){
  var phase=props.phase,preCheckComplete=props.preCheckComplete,settings=props.settings;
  var sessions=getSessions(settings);
  var rule=sessions.find(function(s){return s.id===phase;})||null;
  var isClosed=phase==="closed";
  var sessionColor=rule?rule.color||"#10b981":"#64748b";
  var sessionName=isClosed?"Market Closed":rule?rule.name||"Unknown Session":"No Active Session";
  var content={title:sessionName.toUpperCase(),color:isClosed?"#64748b":sessionColor};
  var customNotes=rule&&rule.notes?rule.notes.trim():"";
  var sessionEnabled=!isClosed&&rule&&rule.enabled!==false;
  var sizingLine="";
  if(rule&&!isClosed&&preCheckComplete){
    if(sessionEnabled)sizingLine=Math.round((rule.sizeFraction||1)*100)+"% size, max "+(rule.maxTrades!=null?rule.maxTrades:99)+" trades";
    else sizingLine="Disabled — no trading this session";
  }
  return (
    <div style={CS({marginBottom:props.hideMargin?0:16,border:"1px solid "+content.color+"44",height:"100%",boxSizing:"border-box"})}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Current Session</div>
        {sizingLine&&<div style={{fontSize:11,color:sessionEnabled?"#22c55e":"#64748b",fontWeight:600}}>{sizingLine}</div>}
      </div>
      <div style={{fontSize:16,fontWeight:700,color:content.color,marginBottom:8}}>{content.title}</div>
      {customNotes?(
        <div style={{fontSize:14,color:"#e2e8f0",lineHeight:1.6,whiteSpace:"pre-wrap",borderLeft:"3px solid "+content.color,paddingLeft:10}}>{customNotes}</div>
      ):(
        <div style={{fontSize:14,color:"#94a3b8",lineHeight:1.6,fontStyle:"italic"}}>{isClosed?"Review your trades in the Journal.":rule?"No session notes — add them in Settings → Session Strategy.":"No active session — times don't match any configured session."}</div>
      )}
      {/* CHANGED: Today's economic events (filtered by user's saved currency / impact filters) shown below the session notes. */}
      {(function(){
        var ev=getTodaysFilteredEvents();
        if(!ev||ev.length===0)return null;
        var now=getPT();
        function fmtTime(d){var h=d.getHours();var m=d.getMinutes();var ap=h>=12?"PM":"AM";var hh=h%12||12;return hh+":"+String(m).padStart(2,"0")+" "+ap;}
        function impColor(imp){if(imp==="high")return "#ef4444";if(imp==="medium")return "#fbbf24";return "#64748b";}
        return (
          <div style={{marginTop:12,paddingTop:10,borderTop:"1px solid #1e293b"}}>
            <div style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:6}}>Today's Events · {ev.length}</div>
            <div style={{display:"flex",flexDirection:"column",gap:4}}>
              {ev.map(function(e,i){
                var imp=normalizeImpact(e.impact);
                var past=e._d<now;
                return (
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,opacity:past?0.55:1}}>
                    <span style={{width:6,height:6,borderRadius:"50%",background:impColor(imp),flexShrink:0}}/>
                    <span style={{color:"#94a3b8",fontVariantNumeric:"tabular-nums",minWidth:60}}>{fmtTime(e._d)}</span>
                    <span style={{color:"#64748b",fontSize:10,fontWeight:700,letterSpacing:0.5}}>{eventCurrency(e)}</span>
                    <span style={{color:past?"#64748b":"#e2e8f0",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.title||e.name||""}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// CHANGED: TradeTile redesigned for clearer visual hierarchy and easier scanning.
// Header: instrument · direction (left), P&L (right).
// Prices banner: prominent ENTRY → EXIT.
// Single meta line: time, duration, contracts, grade.
// Body: setup chain, tags, notes, screenshots — each in its own clean row.
function TradeTile(props){
  var t=props.t,i=props.i,onDelete=props.onDelete,onEdit=props.onEdit;
  var hideControls=!!props.hideControls;
  var [tileViewer,setTileViewer]=useState(null);
  var pnl=parseFloat(t.pnl||0);
  var pctPnl=parseFloat(t.pctPnl||0);
  var hasPnl=t.pnl!==""&&t.pnl!=null&&!isNaN(pnl);
  var hasPct=t.pctPnl!==""&&t.pctPnl!=null&&!isNaN(pctPnl);
  var emos=filterEmotions(t.emotions||[]);
  var effViolations=(t.violations||[]).slice();
  var pos=parseFloat(t.positionSize)||0;
  // CHANGED: Prefer the position max stamped on the trade at save time; fall back to the current setting.
  var posMax=(parseFloat(t.posMaxAtEntry)>0)?parseFloat(t.posMaxAtEntry):(props.posMax||0);
  if(posMax>0&&pos>posMax&&effViolations.indexOf("Oversized entry")<0){effViolations.push("Oversized entry");}
  // CHANGED: Show "Max risk exceeded" when a losing trade's price-move loss beat the stamped
  // session-scaled risk cap. Uses the threshold stamped at save time (settings-independent here).
  var slThresh=parseFloat(t.stopThreshPctAtEntry)||0;
  if(slThresh>0&&!isNaN(pnl)&&pnl<0&&!isNaN(pctPnl)&&pctPnl<-slThresh&&effViolations.indexOf("Max risk exceeded")<0){effViolations.push("Max risk exceeded");}
  var setupChain=[t.setup,t.timeframe,t.candlePattern].filter(function(x){return !!x;});
  var hasSetupInfo=setupChain.length>0;
  var hasTags=emos.length>0||effViolations.length>0;
  var shots=t.screenshots||[];
  var showButtons=!hideControls&&(onEdit||onDelete);

  // Weighted-average entry and exit prices.
  var entries=t.entries||[],exits=t.exits||[];
  var entryTC=0,entryCost=0;
  entries.forEach(function(en){var ec=parseFloat(en.contracts),ep=parseFloat(en.price);if(!isNaN(ec)&&!isNaN(ep)){entryTC+=ec;entryCost+=ec*ep;}});
  var avgEntry=entryTC>0?entryCost/entryTC:NaN;
  var exitTC=0,exitProc=0;
  exits.forEach(function(ex){var ec=parseFloat(ex.contracts),ep=parseFloat(ex.price);if(!isNaN(ec)&&!isNaN(ep)){exitTC+=ec;exitProc+=ec*ep;}});
  var avgExit=exitTC>0?exitProc/exitTC:NaN;
  var hasPriceInfo=!isNaN(avgEntry)||!isNaN(avgExit);
  var isOpen=t.status==="open";

  // Colors / styling
  var dirColor=getDirectionColor(t.direction);
  var dirBg=dirColor==="#22c55e"?"#14532d":dirColor==="#ef4444"?"#7f1d1d":"#1e293b";
  var dirText=dirColor==="#22c55e"?"#86efac":dirColor==="#ef4444"?"#fca5a5":"#94a3b8";
  var gradeColor=t.grade==="A"?"#22c55e":t.grade==="B"?"#f59e0b":t.grade==="C"?"#ef4444":"#64748b";
  var pnlColor=pnl>=0?"#22c55e":"#ef4444";
  var borderColor=hasPnl?(pnl>=0?"#16653455":"#7f1d1d55"):"#1e293b";

  // CHANGED: Derive trade start time from first entry leg, duration from last exit - first entry.
  var entries=t.entries||[],exits=t.exits||[];
  var entryTimes=entries.map(function(e){return e.time;}).filter(Boolean);
  var exitTimes=exits.map(function(e){return e.time;}).filter(Boolean);
  var firstEntryTime=entryTimes.length>0?Math.min.apply(null,entryTimes):(t.openedAt||null);
  var lastExitTime=exitTimes.length>0?Math.max.apply(null,exitTimes):(t.closedAt||null);
  var timeText=firstEntryTime
    ?(fmtTime(new Date(firstEntryTime))+(lastExitTime&&lastExitTime>firstEntryTime?" · "+fmtDuration(lastExitTime-firstEntryTime):""))
    :(t.time||"");
  var cls=getAssetClass(t.assetClass);
  var contractsText="";
  if(t.contracts){var cN=parseFloat(t.contracts);contractsText=t.contracts+" "+(cN===1?cls.unitSingular:cls.unit);}
  // CHANGED: Grade moved to hero row (top-left). Contracts moved to price banner. Meta line is now just time/duration.

  return (
    <div style={{background:"#111118",border:"1px solid #1e293b",borderLeft:"3px solid "+borderColor,borderRadius:10,padding:"14px 16px",marginBottom:10,height:"100%",boxSizing:"border-box",display:"flex",flexDirection:"column"}}>

      {/* HEADER ROW: identifier cluster (left) | edit/delete (right) */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
        <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{fontSize:11,color:"#475569",fontWeight:600,fontVariantNumeric:"tabular-nums"}}>#{i+1}</span>
          {t.grade&&<span style={{fontSize:11,padding:"2px 8px",borderRadius:4,border:"1px solid "+gradeColor,color:gradeColor,fontWeight:700,letterSpacing:0.5,background:gradeColor+"11"}}>{t.grade}</span>}
          {t.instrument&&<span style={{fontSize:18,fontWeight:800,color:"#f1f5f9",letterSpacing:-0.2,lineHeight:1}}>{t.instrument}</span>}
          {t.direction&&<span style={{fontSize:11,padding:"3px 9px",borderRadius:4,background:dirBg,color:dirText,fontWeight:700,letterSpacing:0.5}}>{t.direction}{(t.strike!=null&&t.strike!==""&&!isNaN(parseFloat(t.strike)))?(" $"+(function(){var n=parseFloat(t.strike);return n%1===0?n.toFixed(0):n.toString();})()):""}</span>}
          {isOpen&&<span style={{fontSize:10,padding:"2px 7px",background:"#7c2d1244",border:"1px solid #ea580c",borderRadius:3,color:"#fb923c",fontWeight:700,letterSpacing:0.5}}>OPEN</span>}
        </div>
        {showButtons&&(
          <div style={{display:"flex",gap:5,flexShrink:0}}>
            {onEdit&&<button onClick={onEdit} style={{padding:"4px 10px",background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#94a3b8",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:600,letterSpacing:0.4}}>Edit</button>}
            {onDelete&&<button onClick={onDelete} aria-label="Delete" style={{padding:"4px 9px",background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#64748b",fontSize:13,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>}
          </div>
        )}
      </div>

      {/* P&L ROW: when $ is hidden, show % in the large slot; otherwise show $ + smaller %. */}
      {hasPnl&&(
        <div style={{display:"flex",alignItems:"baseline",gap:10,marginTop:8}}>
          {HIDE_DOLLAR_PNL
            ? (hasPct&&<div style={{fontSize:18,fontWeight:800,color:pnlColor,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{pctPnl>=0?"+":""}{pctPnl.toFixed(2)}%</div>)
            : (<>
                <div style={{fontSize:18,fontWeight:800,color:pnlColor,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{(pnl>=0?"+":"-")+"$"+Math.abs(pnl).toFixed(2)}</div>
                {hasPct&&<div style={{fontSize:13,color:pctPnl>=0?"#86efac":"#fca5a5",fontWeight:600,fontVariantNumeric:"tabular-nums"}}>({pctPnl>=0?"+":""}{pctPnl.toFixed(2)}%)</div>}
              </>)}
        </div>
      )}

      {/* PRICE BANNER: Entry → Exit, with position size in the middle */}
      {hasPriceInfo&&(
        <div style={{marginTop:10,padding:"9px 12px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:7,display:"flex",alignItems:"center",justifyContent:"space-around",gap:8}}>
          {!isNaN(avgEntry)&&(
            <div style={{textAlign:"center",flex:1,minWidth:0}}>
              <div style={{fontSize:9,color:"#64748b",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700,marginBottom:2}}>Entry{entries.length>1?" (avg)":""}</div>
              <div style={{fontSize:16,fontWeight:700,color:"#e2e8f0",fontVariantNumeric:"tabular-nums",lineHeight:1}}>${avgEntry.toFixed(2)}</div>
            </div>
          )}
          {!isNaN(avgEntry)&&!isNaN(avgExit)&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0,gap:1}}>
              {pos>0
                ?<div style={{fontSize:16,fontWeight:700,color:(posMax>0&&pos>posMax)?"#fb923c":"#94a3b8",lineHeight:1,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{fmtPositionDisplay(pos)}</div>
                :<div style={{color:"#475569",fontSize:18,fontWeight:600,lineHeight:1}}>→</div>}
              {contractsText&&<div style={{fontSize:13,color:"#64748b",fontWeight:600,letterSpacing:0.2,whiteSpace:"nowrap"}}>{contractsText}</div>}
            </div>
          )}
          {!isNaN(avgExit)&&(
            <div style={{textAlign:"center",flex:1,minWidth:0}}>
              <div style={{fontSize:9,color:"#64748b",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700,marginBottom:2}}>Exit{exits.length>1?" (avg)":""}</div>
              <div style={{fontSize:16,fontWeight:700,color:"#e2e8f0",fontVariantNumeric:"tabular-nums",lineHeight:1}}>${avgExit.toFixed(2)}</div>
            </div>
          )}
          {!isNaN(avgEntry)&&isNaN(avgExit)&&(
            <div style={{textAlign:"center",flex:1,minWidth:0}}>
              <div style={{fontSize:9,color:"#fb923c",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700,marginBottom:2}}>Position open{contractsText?" · "+contractsText:""}</div>
              <div style={{fontSize:13,color:"#94a3b8",lineHeight:1}}>—</div>
            </div>
          )}
          {((!isNaN(avgEntry)&&!isNaN(avgExit))===false&&!isNaN(avgEntry)===false&&contractsText)&&(
            <div style={{fontSize:10,color:"#64748b",fontWeight:600,letterSpacing:0.4,marginLeft:6}}>{contractsText}</div>
          )}
        </div>
      )}

      {/* META: time · duration · (contracts inline when price banner is hidden) */}
      {timeText&&(
        <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#64748b",marginTop:8,fontVariantNumeric:"tabular-nums"}}>
          <span>{timeText}</span>
          {!hasPriceInfo&&contractsText&&<span><span style={{color:"#334155",margin:"0 6px"}}>·</span>{contractsText}</span>}
        </div>
      )}

      {/* STRATEGY GROUP: setup chain + indicators together, separated from header by a subtle divider */}
      {(hasSetupInfo||(t.indicators||[]).length>0)&&(
        <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #1e293b"}}>
          {hasSetupInfo&&(
            <div style={{fontSize:13,color:"#cbd5e1",fontWeight:500}}>
              {setupChain.map(function(s,idx){return <span key={idx}>{idx>0&&<span style={{color:"#334155",margin:"0 7px"}}>›</span>}{s}</span>;})}
            </div>
          )}
          {(t.indicators||[]).length>0&&(
            <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap",marginTop:hasSetupInfo?6:0}}>
              {t.indicators.map(function(ind){return <span key={ind} style={{fontSize:11,padding:"2px 7px",borderRadius:3,background:"#1e293b",color:"#a5b4fc",fontWeight:600}}>{ind}</span>;})}
            </div>
          )}
        </div>
      )}

      {/* TAGS: emotions + violations */}
      {hasTags&&(
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:8}}>
          {emos.map(function(e){return <Tag key={e} label={e} color={emotionTagColor(e)}/>;})}
          {effViolations.map(function(v){return <Tag key={v} label={"⚠ "+v} color="#f87171"/>;})}
        </div>
      )}

      {/* NOTES */}
      {t.notes&&(
        <div style={{marginTop:8,padding:"7px 11px",background:"#0a0a0f",borderLeft:"3px solid #334155",borderRadius:"0 5px 5px 0",fontSize:13,color:"#cbd5e1",fontStyle:"italic",lineHeight:1.5}}>{t.notes}</div>
      )}

      {/* SCREENSHOTS */}
      {shots.length>0&&(
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>
          {shots.map(function(src,si){return <img key={si} src={src} alt={"Screenshot "+(si+1)} onClick={function(){setTileViewer(src);}} style={{width:58,height:58,objectFit:"cover",borderRadius:5,border:"1px solid #334155",cursor:"pointer"}}/>;})}
        </div>
      )}

      {tileViewer&&(
        <div onClick={function(){setTileViewer(null);}} style={{position:"fixed",inset:0,zIndex:2000,background:"#000000ee",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",cursor:"pointer"}}>
          <img src={tileViewer} alt="Screenshot" style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",borderRadius:6}}/>
          <button aria-label="Close" style={{position:"absolute",top:14,right:14,width:36,height:36,padding:0,background:"#1e293b",border:"1px solid #475569",borderRadius:"50%",color:"#e2e8f0",fontSize:18,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>✕</button>
        </div>
      )}
    </div>
  );
}

// CHANGED: Module-scope collapsible form section so React tracks it as a stable component.
function FormSection(props){
  var [open,setOpen]=useState(true);
  var hasContent=props.hasContent!==false;
  var mb=props.mb||10;
  return (
    <div style={{marginBottom:mb,background:"#0a0a0f",border:"1px solid "+(hasContent?"#334155":"#1e293b"),borderRadius:8}}>
      <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 11px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <span style={{fontSize:10,color:hasContent?"#94a3b8":"#475569",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>{props.label}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{flexShrink:0,transition:"transform 0.15s",transform:open?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open&&<div style={{padding:"2px 11px 10px"}}>{props.children}</div>}
    </div>
  );
}

// CHANGED: Reusable polished dropdown — matches the Performance "Range" picker visual style.
// Replaces native <select> across the app. variant="field" (rectangular, form input) or
// "pill" (rounded chip). Options is an array of {v, l} (value, label).
function Dropdown(props){
  var [open,setOpen]=React.useState(false);
  var value=props.value;
  var options=props.options||[];
  var variant=props.variant||"field";
  var disabled=!!props.disabled;
  var placeholder=props.placeholder||"Select…";
  var current=options.find(function(o){return o.v===value;});
  var hasValue=current!=null;
  var rootStyle={position:"relative",display:variant==="pill"?"inline-block":"block",width:variant==="pill"?"auto":"100%"};
  var triggerBase=variant==="pill"
    ? {display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"7px 14px 7px 16px",background:hasValue?"linear-gradient(135deg,#4338ca,#4f46e5)":"#0a0a0f",border:"1px solid "+(hasValue?"#6366f1":"#334155"),borderRadius:999,color:hasValue?"#fff":"#94a3b8",fontSize:13,fontWeight:hasValue?700:500,cursor:disabled?"not-allowed":"pointer",fontFamily:"inherit",boxShadow:hasValue?"0 1px 4px #4f46e533":"none",opacity:disabled?0.5:1}
    : {display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"10px 12px",width:"100%",background:"#0a0a0f",border:"1px solid "+(open?"#4338ca":"#334155"),borderRadius:8,color:hasValue?"#e2e8f0":"#64748b",fontSize:13,fontWeight:500,cursor:disabled?"not-allowed":"pointer",fontFamily:"inherit",textAlign:"left",opacity:disabled?0.5:1,transition:"border-color 0.12s"};
  var trigStyle=Object.assign({},triggerBase,props.style||{});
  return (
    <div style={rootStyle}>
      <button type="button" disabled={disabled} onClick={function(){if(!disabled)setOpen(function(o){return !o;});}} style={trigStyle}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{current?current.l:placeholder}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" style={{flexShrink:0,transform:open?"rotate(180deg)":"none",transition:"transform 0.15s ease"}}><path d="M2 4l3 3 3-3" stroke={variant==="pill"&&hasValue?"#fff":(variant==="field"?"#94a3b8":"#94a3b8")} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open&&(
        <>
          <div onClick={function(){setOpen(false);}} style={{position:"fixed",inset:0,zIndex:30}}/>
          <div style={{position:"absolute",top:"calc(100% + 6px)",left:0,minWidth:"100%",zIndex:31,background:"#0a0a0f",border:"1px solid #334155",borderRadius:10,padding:4,boxShadow:"0 8px 24px #00000080",maxHeight:280,overflowY:"auto"}}>
            {options.map(function(o){
              var on=o.v===value;
              return (
                <button key={String(o.v)} type="button" onClick={function(){if(props.onChange)props.onChange(o.v);setOpen(false);}} onMouseEnter={function(e){if(!on)e.currentTarget.style.background="#1e1b4b";}} onMouseLeave={function(e){if(!on)e.currentTarget.style.background="transparent";}} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",padding:"8px 12px",background:on?"#1e1b4b":"transparent",border:"none",borderRadius:6,color:on?"#a5b4fc":"#cbd5e1",fontSize:13,fontWeight:on?700:500,cursor:"pointer",fontFamily:"inherit",textAlign:"left",transition:"background 0.1s",whiteSpace:"nowrap"}}>
                  <span>{o.l}</span>
                  {on&&<span style={{color:"#a5b4fc",fontSize:11,marginLeft:8}}>✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function TradeForm(props){
  var trade=props.trade,setTrade=props.setTrade,onSave=props.onSave,onCancel=props.onCancel,settings=props.settings;
  var opts=props.tradeOptions||defaultOptions();
  var screenshotInputRef=useRef(null);
  var [uploadingShot,setUploadingShot]=useState(false);
  var [shotError,setShotError]=useState(null);
  var [viewerShot,setViewerShot]=useState(null);
  // CHANGED: Track which leg's time is being edited inline. Format: "Entry-2" or "Exit-0".
  var [editingLegTime,setEditingLegTime]=useState(null);
  // CHANGED: Track custom instrument input mode separately from trade.instrument value.
  var [customInstrumentMode,setCustomInstrumentMode]=useState(false);
  // CHANGED: Pre-trade checklist state. checkedKeys = which items have been ticked. Resets when asset class changes.
  var [pretradeChecked,setPretradeChecked]=useState({});
  function upd(k,v){setTrade(function(t){return Object.assign({},t,{[k]:v});});}
  var st=setTrade;
  // CHANGED: Resolve asset class — session default overrides global default for new trades.
  var sessionDefaultAsset=(function(){
    if(trade.assetClass)return null; // already set, don't override
    var sessions=settings&&settings.sessions?settings.sessions:[];
    var phase=trade.sessionId;
    if(!phase)return null;
    var sess=sessions.find(function(s){return s.id===phase;});
    return sess&&sess.defaultAssetClass?sess.defaultAssetClass:null;
  })();
  var assetClassId=trade.assetClass||sessionDefaultAsset||(settings&&settings.defaultAssetClass)||"options";
  var assetClass=getAssetClass(assetClassId);
  var formSections=getFormSectionsForClass(settings,assetClassId);
  // CHANGED: Always show all classes that the user has enabled. Fall back to defaults if none.
  var enabledClasses=ASSET_CLASS_ORDER.filter(function(c){return (settings&&settings.enabledAssetClasses)?settings.enabledAssetClasses[c]:c==="options";});
  if(enabledClasses.length===0)enabledClasses=ASSET_CLASS_ORDER.slice();
  var savedInstruments=loadInstruments();
  var classInstruments=getInstrumentsForClass(savedInstruments,assetClassId);
  // CHANGED: Apply default instrument for the current asset class (if set in settings) when the trade doesn't have one yet.
  useEffect(function(){
    if(!trade.instrument&&settings&&settings.defaultInstruments&&settings.defaultInstruments[assetClassId]){
      var def=settings.defaultInstruments[assetClassId];
      var exists=classInstruments.some(function(it){return it.symbol===def;});
      if(exists){upd("instrument",def);}
    }
    // CHANGED: When the user switches asset class, clear the pre-trade checklist's checked state.
    setPretradeChecked({});
  },[assetClassId]);
  // CHANGED: Resolve pre-trade checklist for current asset class + selected setup.
  var pretradeItems=getPretradeItemsForClass(assetClassId,trade.setup||"");
  // CHANGED: Skip pretrade checklist gate when editing an existing saved trade.
  var isExistingTrade=!!(trade.id&&(trade.entries||[]).length>0);
  var pretradeComplete=isExistingTrade||pretradeItems.length===0||pretradeItems.every(function(it){
    var checked=!!pretradeChecked[it.key];
    // Inverted items pass when UNchecked (the question is in negative form like "Are candles overlapping?").
    return it.inverted?!checked:checked;
  });
  var unitLabel=assetClass.unit;
  var unitLabelSingular=assetClass.unitSingular;
  // CHANGED: Per-asset-class quantity and price labels for leg inputs.
  var qtyLabel=assetClass.qtyLabel||(unitLabel.charAt(0).toUpperCase()+unitLabel.slice(1));
  var priceLabel=assetClass.priceLabel||"Price";
  var entries=trade.entries||[],exits=trade.exits||[];
  var avgEntry=NaN,totalEntryC=0,totalCost=0;
  entries.forEach(function(en){var ec=parseFloat(en.contracts),ep=parseFloat(en.price);if(!isNaN(ec)&&!isNaN(ep)){totalEntryC+=ec;totalCost+=ec*ep;}});
  if(totalEntryC>0)avgEntry=totalCost/totalEntryC;
  var totalExitC=exits.reduce(function(s,ex){return s+(parseFloat(ex.contracts)||0);},0);
  var remaining=totalEntryC>0?totalEntryC-totalExitC:null;
  var dollarPnl=parseFloat(trade.pnl)||0,pctPnlVal=parseFloat(trade.pctPnl)||0;
  var showPnL=trade.pnl!==""&&exits.some(function(ex){return ex.contracts&&ex.price;});
  // CHANGED: Use the session-/lock-scaled cap from props (matches the banner shown above) so the
  // form flags oversized entries during half-size trading too. Fall back to settings only if not provided.
  var effPosMaxForForm=parseFloat(props.displayPosMax);
  if(!(effPosMaxForForm>0))effPosMaxForForm=parseFloat(settings.positionMax)||0;
  var posExceedsMax=trade.positionSize&&effPosMaxForForm>0&&parseFloat(trade.positionSize)>effPosMaxForForm;
  var legCount=entries.length+exits.length;
  var hasEvaluation=!!(trade.grade||(trade.emotions&&trade.emotions.length)||(trade.violations&&trade.violations.length)||trade.notes);
  var density=0;
  if(trade.direction||trade.setup||trade.timeframe||trade.candlePattern||legCount>0)density=1;
  if(legCount>=2)density=2;
  if(legCount>=4||hasEvaluation)density=3;
  var sectionPad=density>=3?"6px 10px":density>=2?"8px 11px":"10px 12px";
  var sectionMb=density>=3?6:density>=2?8:10;
  var fldHeader=density>=3?5:density>=2?6:8;
  var rowGap=density>=3?4:density>=2?5:6;
  var legGap=density>=2?6:8;
  var compactFld=density>=3?Object.assign({},fld,{padding:"6px 9px",fontSize:13}):density>=2?Object.assign({},fld,{padding:"7px 10px",fontSize:14}):fld;
  var lblCompact=density>=3?Object.assign({},lbl,{marginBottom:2,fontSize:10}):density>=2?Object.assign({},lbl,{marginBottom:3}):lbl;
  var showHelper=density===0;
  return (
    <div style={{position:"fixed",inset:0,zIndex:1000,background:"#0a0a0fee",backdropFilter:"blur(4px)",display:"flex",flexDirection:"column",padding:"12px"}}>
      <div style={{flex:1,display:"flex",flexDirection:"column",background:"#111118",border:"1px solid #4338ca",borderRadius:12,maxWidth:props.mobile?520:920,margin:"0 auto",width:"100%",overflow:"hidden"}}>
        <div style={{padding:"12px 16px",borderBottom:"1px solid #1e293b",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <div style={{fontSize:15,fontWeight:700,color:"#818cf8"}}>Log Trade</div>
          <button onClick={onCancel} aria-label="Close" style={{background:"none",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:14,cursor:"pointer",padding:"4px 9px",fontFamily:"inherit"}}>✕</button>
        </div>
        {/* CHANGED: Show current allowed position & risk sizing as a quick reference at top of form.
            These are planning inputs and always show $ (even when hide-$ is enabled elsewhere). */}
        {(props.displayPosMin!=null||props.displayRiskMin!=null)&&(
          <div style={{padding:"8px 16px",borderBottom:"1px solid #1e293b",display:"flex",gap:16,flexShrink:0,background:"#0a0a0f"}}>
            <div style={{flex:1}}>
              <div style={{fontSize:9,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Position</div>
              <div style={{fontSize:14,fontWeight:700,color:"#818cf8",marginTop:2}}>{"$"+props.displayPosMin+" "}<span style={{fontSize:10,color:"#94a3b8",fontWeight:500}}>– ${props.displayPosMax}</span></div>
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:9,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Risk</div>
              <div style={{fontSize:14,fontWeight:700,color:"#ef4444",marginTop:2}}>{"$"+props.displayRiskMin+" "}<span style={{fontSize:10,color:"#94a3b8",fontWeight:500}}>– ${props.displayRiskMax}</span></div>
            </div>
          </div>
        )}
        <div style={{flex:1,overflowY:"auto",padding:density>=3?"8px 12px":density>=2?"10px 13px":"12px 14px"}}>
          <div style={{maxWidth:props.mobile?"none":760,margin:"0 auto"}}>
          {showHelper&&<div style={{background:"#1e1b4b33",border:"1px solid #4338ca44",borderRadius:8,padding:"7px 12px",marginBottom:10,fontSize:12,color:"#a5b4fc"}}>Am I entering based on a signal or impulse?</div>}
          {enabledClasses.length>1&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:rowGap,marginBottom:sectionMb}}>
              <div>
                <label style={lblCompact}>Asset Class</label>
                <Dropdown value={assetClassId} onChange={function(newCls){
                  setTrade(function(t){
                    var nc=getAssetClass(newCls);
                    var dir=t.direction;
                    if(dir&&nc.directions.indexOf(dir)<0)dir="";
                    return Object.assign({},t,{assetClass:newCls,direction:dir,instrument:""});
                  });
                }} options={enabledClasses.map(function(c){return {v:c,l:ASSET_CLASSES[c].label};})} style={compactFld}/>
              </div>
              <div>
                <label style={lblCompact}>Instrument</label>
                {classInstruments.length>0?(
                  <Dropdown value={customInstrumentMode?"__custom__":(trade.instrument||"")} onChange={function(v){if(v==="__custom__"){setCustomInstrumentMode(true);st(function(p){return Object.assign({},p,doRecalc(p.entries||[],p.exits||[],p.assetClass,"",p.direction),{instrument:""});});}else{setCustomInstrumentMode(false);st(function(p){return Object.assign({},p,doRecalc(p.entries||[],p.exits||[],p.assetClass,v,p.direction),{instrument:v});});}}} placeholder="Select..." options={[{v:"",l:"Select..."}].concat(classInstruments.map(function(it){return {v:it.symbol,l:it.symbol+(it.name?" — "+it.name:"")};})).concat([{v:"__custom__",l:"+ Custom..."}])} style={compactFld}/>
                ):(
                  <input value={trade.instrument||""} onChange={function(e){var v=e.target.value.toUpperCase();st(function(p){return Object.assign({},p,doRecalc(p.entries||[],p.exits||[],p.assetClass,v,p.direction),{instrument:v});});}} placeholder="SPY" style={Object.assign({},compactFld,{colorScheme:"dark",color:"#e2e8f0"})}/>
                )}
              </div>
            </div>
          )}
          {enabledClasses.length>1&&customInstrumentMode&&(
            <div style={{marginBottom:sectionMb}}>
              <label style={lblCompact}>Custom Symbol</label>
              <input autoFocus value={trade.instrument||""} onChange={function(e){var v=e.target.value.toUpperCase();st(function(p){return Object.assign({},p,doRecalc(p.entries||[],p.exits||[],p.assetClass,v,p.direction),{instrument:v});});}} placeholder="Type symbol..." style={Object.assign({},compactFld,{colorScheme:"dark",color:"#e2e8f0"})}/>
            </div>
          )}
          {assetClassId==="futures"&&trade.instrument&&getFuturesSpec(trade.instrument)&&(
            <div style={{marginBottom:sectionMb,padding:"5px 9px",background:"#0a1f10",border:"1px solid #166534",borderRadius:6,fontSize:11,color:"#86efac"}}>
              {getFuturesSpec(trade.instrument).name}: ${getFuturesSpec(trade.instrument).pointValue}/point · tick {getFuturesSpec(trade.instrument).tickSize}
            </div>
          )}
          {assetClassId==="futures"&&trade.instrument&&!getFuturesSpec(trade.instrument)&&(
            <div style={{marginBottom:sectionMb,padding:"5px 9px",background:"#1c1509",border:"1px solid #713f12",borderRadius:6,fontSize:11,color:"#fdba74"}}>
              Unknown contract "{trade.instrument}" — P&L will use $1/point. Add to FUTURES_SPECS for accuracy.
            </div>
          )}
          {/* CHANGED: Setup selector — placed above pre-trade checklist so checklist items can be setup-specific. */}
          {!isExistingTrade&&(
            <div style={{marginBottom:sectionMb}}>
              <label style={lblCompact}>Setup</label>
              <Dropdown value={trade.setup||""} onChange={function(v){upd("setup",v);setPretradeChecked({});}} placeholder="Select setup..." options={[{v:"",l:"Select setup..."}].concat(opts.setup.map(function(s){return {v:s,l:s};}))} style={compactFld}/>
            </div>
          )}
          {/* CHANGED: Pre-trade checklist for the current asset class. Form below is locked until complete. */}
          {/* CHANGED: Pre-trade checklist hidden when editing an existing trade. */}
          {!isExistingTrade&&pretradeItems.length>0&&(
            <div style={{marginBottom:sectionMb,padding:"10px 12px",background:pretradeComplete?"#0a1f10":"#1c1509",border:"1px solid "+(pretradeComplete?"#166534":"#713f12"),borderRadius:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <span style={{fontSize:11,color:pretradeComplete?"#86efac":"#fdba74",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Pre-Trade Checklist</span>
                <span style={{fontSize:11,color:pretradeComplete?"#86efac":"#fdba74",fontWeight:600,fontVariantNumeric:"tabular-nums"}}>{(function(){var n=pretradeItems.filter(function(it){var c=!!pretradeChecked[it.key];return it.inverted?!c:c;}).length;return n+"/"+pretradeItems.length;})()}</span>
              </div>
              {pretradeItems.map(function(it){
                var checked=!!pretradeChecked[it.key];
                var passes=it.inverted?!checked:checked;
                return (
                  <label key={it.key} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 0",cursor:"pointer",fontSize:13,color:passes?"#86efac":"#cbd5e1"}}>
                    <ToggleSwitch checked={checked} onChange={function(v){setPretradeChecked(function(prev){return Object.assign({},prev,{[it.key]:v});});}}/>
                    <span style={{flex:1}}>{it.label}{it.inverted&&<span style={{fontSize:10,color:"#fdba74",marginLeft:6,fontStyle:"italic"}}>(should NOT apply)</span>}</span>
                  </label>
                );
              })}
              {!pretradeComplete&&<div style={{fontSize:11,color:"#fdba74",fontStyle:"italic",marginTop:6}}>Complete the checklist to unlock the form.</div>}
            </div>
          )}
          {/* CHANGED: Lock wrapper. Disables interaction until pre-trade checklist is complete. */}
          <div style={{pointerEvents:pretradeComplete?"auto":"none",opacity:pretradeComplete?1:0.4,transition:"opacity 0.2s"}}>
          {(assetClass.showStrike||assetClass.showExpiry)&&(
            <div style={{display:"grid",gridTemplateColumns:assetClass.showStrike&&assetClass.showExpiry?"1fr 1fr":"1fr",gap:rowGap,marginBottom:sectionMb}}>
              {assetClass.showStrike&&<div><label style={lblCompact}>Strike</label><input type="number" step="0.01" value={trade.strike||""} onChange={function(e){upd("strike",e.target.value);}} placeholder="0.00" style={compactFld}/></div>}
              {assetClass.showExpiry&&(function(){
                var n=getNow();
                // For futures: next quarterly month (Mar/Jun/Sep/Dec), 3rd Friday.
                // For other classes: today.
                var defaultISO;
                if(assetClassId==="futures"){
                  var y=n.getFullYear(),m=n.getMonth(); // 0-indexed
                  // Find next quarterly month (2=Mar, 5=Jun, 8=Sep, 11=Dec)
                  var quarterly=[2,5,8,11];
                  var nextQ=quarterly.find(function(q){return q>=m;});
                  if(nextQ===undefined){nextQ=2;y++;}
                  // If we're already in the quarterly month, check if 3rd Friday has passed
                  if(nextQ===m){
                    var firstDay=new Date(y,nextQ,1).getDay(); // 0=Sun, 5=Fri
                    var firstFri=firstDay<=5?(6-firstDay):(13-firstDay); // date of 1st Friday
                    var thirdFri=firstFri+14;
                    if(n.getDate()>thirdFri){
                      // Past expiry, roll to next quarter
                      var idx=quarterly.indexOf(nextQ);
                      if(idx===3){nextQ=2;y++;}else{nextQ=quarterly[idx+1];}
                    }
                  }
                  // Calculate 3rd Friday of nextQ/y
                  var fd=new Date(y,nextQ,1).getDay();
                  var ff=fd<=5?(6-fd):(13-fd);
                  var tf=ff+14;
                  defaultISO=y+"-"+(nextQ+1).toString().padStart(2,"0")+"-"+tf.toString().padStart(2,"0");
                }else{
                  defaultISO=n.getFullYear()+"-"+(n.getMonth()+1).toString().padStart(2,"0")+"-"+n.getDate().toString().padStart(2,"0");
                }
                var val=trade.expiry||defaultISO;
                return <div><label style={lblCompact}>Expiry</label><input type="date" onMouseDown={function(e){var inp=e.currentTarget;setTimeout(function(){try{inp.focus();if(inp.showPicker)inp.showPicker();}catch(err){}},0);}} value={val} onChange={function(e){upd("expiry",e.target.value);}} style={Object.assign({},compactFld,{colorScheme:"dark",color:"#e2e8f0"})}/></div>;
              })()}
            </div>
          )}
          <FormSection label="Setup & Analysis" mb={sectionMb} hasContent={!!(trade.direction||trade.setup||trade.timeframe||trade.candlePattern||(trade.indicators||[]).length)}>
          {(function(){
            // CHANGED: Setup dropdown is only shown here when editing an existing trade.
            // For new trades, Setup is already chosen above the pre-trade checklist.
            var showSetupHere=isExistingTrade;
            var cols=[];
            cols.push("1fr"); // direction always
            if(showSetupHere)cols.push("1fr");
            if(formSections.timeframe!==false)cols.push("1fr");
            return (
              <div style={{display:"grid",gridTemplateColumns:cols.join(" "),gap:rowGap,marginBottom:sectionMb}}>
                <div><label style={lblCompact}>Direction</label><Dropdown value={trade.direction} onChange={function(v){st(function(p){return Object.assign({},p,doRecalc(p.entries||[],p.exits||[],p.assetClass,p.instrument,v),{direction:v});});}} placeholder="Select" options={[{v:"",l:"Select"}].concat(assetClass.directions.map(function(d){return {v:d,l:d};}))} style={compactFld}/></div>
                {showSetupHere&&<div><label style={lblCompact}>Setup</label><Dropdown value={trade.setup} onChange={function(v){upd("setup",v);}} placeholder="Select" options={[{v:"",l:"Select"}].concat(opts.setup.map(function(s){return {v:s,l:s};}))} style={compactFld}/></div>}
                {formSections.timeframe!==false&&<div><label style={lblCompact}>Timeframe</label><Dropdown value={trade.timeframe||""} onChange={function(v){upd("timeframe",v);}} placeholder="Select" options={[{v:"",l:"Select"}].concat(opts.timeframe.map(function(t){return {v:t,l:t};}))} style={compactFld}/></div>}
              </div>
            );
          })()}
          {formSections.candlePattern!==false&&(
          <div style={{marginBottom:sectionMb}}>
            <label style={lblCompact}>Candle Pattern</label>
            <Dropdown value={trade.candlePattern||""} onChange={function(v){upd("candlePattern",v);}} placeholder="Select..." options={[{v:"",l:"Select..."}].concat(opts.candlePattern.map(function(p){return {v:p,l:p};}))} style={compactFld}/>
          </div>
          )}
          {formSections.indicators!==false&&(
          <div style={{marginBottom:0}}>
            <MultiDropdown label="Indicators" options={opts.indicator||[]} selected={trade.indicators||[]} onChange={function(v){upd("indicators",v);}}/>
          </div>
          )}
          </FormSection>
          <div style={{marginBottom:sectionMb,background:"#0a0a0f",border:"1px solid #334155",borderRadius:10,padding:sectionPad}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:fldHeader}}>
              <label style={Object.assign({},lblCompact,{marginBottom:0,color:"#818cf8"})}>Entry Legs</label>
              <button onClick={function(){st(function(prev){var ne=(prev.entries||[]).concat([mkEntry()]);return Object.assign({},prev,doRecalc(ne,prev.exits||[],prev.assetClass,prev.instrument,prev.direction));});}} style={{padding:density>=2?"4px 12px":"5px 14px",background:"#4f46e5",border:"none",borderRadius:6,color:"#fff",fontSize:density>=2?12:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Add Entry</button>
            </div>
            {entries.length===0&&<div style={{fontSize:13,color:"#475569",padding:"4px 0"}}>No entries yet</div>}
            {entries.map(function(en,i){
              var legKey="Entry-"+i;
              var isEditingTime=editingLegTime===legKey;
              return (
                <div key={en.id} style={{marginBottom:rowGap+2}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:rowGap,alignItems:"end"}}>
                    <div><label style={lblCompact}>{qtyLabel} #{i+1}</label><input type="text" defaultValue={en.contracts} onBlur={function(e){var val=e.target.value;st(function(prev){var ne=prev.entries.map(function(x,xi){return xi===i?Object.assign({},x,{contracts:val}):x;});return Object.assign({},prev,doRecalc(ne,prev.exits||[],prev.assetClass,prev.instrument,prev.direction));});}} style={compactFld}/></div>
                    <div><label style={lblCompact}>{priceLabel} #{i+1}</label><input type="text" defaultValue={en.price} onBlur={function(e){var val=e.target.value;st(function(prev){var ne=prev.entries.map(function(x,xi){return xi===i?Object.assign({},x,{price:val}):x;});return Object.assign({},prev,doRecalc(ne,prev.exits||[],prev.assetClass,prev.instrument,prev.direction));});}} style={compactFld}/></div>
                    <button onClick={function(){st(function(prev){var ne=prev.entries.filter(function(_,xi){return xi!==i;});return Object.assign({},prev,doRecalc(ne,prev.exits||[],prev.assetClass,prev.instrument,prev.direction));});}} style={{padding:density>=2?"6px 9px":"8px 10px",background:"#7f1d1d44",border:"1px solid #7f1d1d",borderRadius:6,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit",marginBottom:1}}>X</button>
                  </div>
                  {/* CHANGED: Per-leg time row — read-only display + Edit toggle. */}
                  <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,paddingLeft:2,fontSize:11}}>
                    <span style={{color:"#64748b",letterSpacing:0.5}}>Time:</span>
                    {isEditingTime
                      ?<input type="time" autoFocus defaultValue={tsToTimeStr(en.time||Date.now())} onBlur={function(e){var v=e.target.value;st(function(prev){var ne=prev.entries.map(function(x,xi){return xi===i?Object.assign({},x,{time:applyTimeStrToTs(x.time,v)}):x;});return Object.assign({},prev,{entries:ne});});setEditingLegTime(null);}} style={Object.assign({},compactFld,{padding:"3px 6px",fontSize:11,width:90,colorScheme:"dark",color:"#e2e8f0"})}/>
                      :<span style={{color:"#cbd5e1",fontVariantNumeric:"tabular-nums"}}>{en.time?fmtTime(new Date(en.time)):"—"}</span>
                    }
                    {!isEditingTime&&<button onClick={function(){setEditingLegTime(legKey);}} style={{padding:"2px 8px",background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#94a3b8",fontSize:10,cursor:"pointer",fontFamily:"inherit",fontWeight:600,letterSpacing:0.3}}>Edit</button>}
                  </div>
                </div>
              );
            })}
            {(totalEntryC>0&&!isNaN(avgEntry)||(trade.positionSize&&parseFloat(trade.positionSize)>0))&&(
              <div style={{display:"grid",gridTemplateColumns:!props.mobile&&trade.stopLoss?"1fr 1fr 1fr 1fr":"1fr 1fr 1fr",gap:rowGap,marginTop:fldHeader}}>
                <div style={{background:"#1e293b",borderRadius:6,padding:density>=2?"4px 8px":"6px 10px"}}><div style={{fontSize:9,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>{unitLabel}</div><div style={{fontSize:density>=2?12:14,fontWeight:700,color:"#38bdf8",marginTop:1}}>{totalEntryC}</div></div>
                <div style={{background:"#1e293b",borderRadius:6,padding:density>=2?"4px 8px":"6px 10px"}}><div style={{fontSize:9,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Avg Entry</div><div style={{fontSize:density>=2?12:14,fontWeight:700,color:"#f59e0b",marginTop:1}}>${avgEntry.toFixed(2)}</div></div>
                <div style={{background:"#1e293b",border:posExceedsMax?"1px solid #ef4444":"none",borderRadius:6,padding:density>=2?"4px 8px":"6px 10px"}}><div style={{fontSize:9,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Position</div><div style={{fontSize:density>=2?12:14,fontWeight:700,color:posExceedsMax?"#ef4444":"#94a3b8",marginTop:1}}>{trade.positionSize?(HIDE_DOLLAR_PNL?pctOfAccount(parseFloat(trade.positionSize)):("$"+parseFloat(trade.positionSize).toFixed(2))):"--"}</div></div>
                {/* CHANGED: Stop Loss MAX now sits inline as a 4th tile on laptop (matches the styling of the others). On mobile it falls back to the dedicated banner below. */}
                {!props.mobile&&trade.stopLoss&&(
                  <div style={{background:"#2a0f0f",border:"1px solid #7f1d1d",borderRadius:6,padding:density>=2?"4px 8px":"6px 10px"}}><div style={{fontSize:9,color:"#fca5a5",letterSpacing:1,textTransform:"uppercase",opacity:0.85}}>Stop Loss MAX</div><div style={{fontSize:density>=2?12:14,fontWeight:700,color:"#fca5a5",marginTop:1}}>${parseFloat(trade.stopLoss).toFixed(2)}</div></div>
                )}
              </div>
            )}
            {/* On mobile, or when there are no entries yet, keep the dedicated banner. */}
            {trade.stopLoss&&(props.mobile||!(totalEntryC>0&&!isNaN(avgEntry)))&&<div style={{marginTop:fldHeader,padding:"5px 10px",background:"#2a0f0f",border:"1px solid #7f1d1d",borderRadius:6,fontSize:density>=2?11:12,color:"#fca5a5"}}>Stop Loss MAX: ${parseFloat(trade.stopLoss).toFixed(2)}</div>}
          </div>
          {/* CHANGED: Exit Plan banner — between entry and exit legs as a reminder before exiting. Shown whenever a session with an exit plan is active. */}
          {(function(){
            var sid=trade.sessionId;
            if(!sid)return null;
            var sess=getSessions(settings).find(function(x){return x.id===sid;});
            var plan=sess&&sess.exitPlan?sess.exitPlan:"";
            if(!plan)return null;
            return (
              <div style={{marginBottom:sectionMb,padding:"8px 10px",background:"#1c1509",border:"1px solid #b45309",borderRadius:6}}>
                <div style={{fontSize:10,color:"#fbbf24",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:4}}>Exit Plan · {sess.name||"Session"}</div>
                <div style={{fontSize:12,color:"#fde68a",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{plan}</div>
              </div>
            );
          })()}
          <div style={{marginBottom:sectionMb,background:"#0a0a0f",border:"1px solid #334155",borderRadius:10,padding:sectionPad}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:fldHeader}}>
              <label style={Object.assign({},lblCompact,{marginBottom:0,color:"#86efac"})}>Exit Legs</label>
              <button onClick={function(){st(function(prev){var ne=(prev.exits||[]).concat([mkExit()]);return Object.assign({},prev,doRecalc(prev.entries||[],ne,prev.assetClass,prev.instrument,prev.direction));});}} style={{padding:density>=2?"4px 12px":"5px 14px",background:"#166534",border:"none",borderRadius:6,color:"#fff",fontSize:density>=2?12:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Add Exit</button>
            </div>
            {exits.length===0&&<div style={{fontSize:13,color:"#475569",padding:"4px 0"}}>No exits yet</div>}
            {exits.map(function(ex,i){
              var legKey="Exit-"+i;
              var isEditingTime=editingLegTime===legKey;
              return (
                <div key={ex.id} style={{marginBottom:rowGap+2}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:rowGap,alignItems:"end"}}>
                    <div><label style={lblCompact}>{qtyLabel} #{i+1}</label><input type="text" defaultValue={ex.contracts} onBlur={function(e){var val=e.target.value;st(function(prev){var ne=prev.exits.map(function(x,xi){return xi===i?Object.assign({},x,{contracts:val}):x;});return Object.assign({},prev,doRecalc(prev.entries||[],ne,prev.assetClass,prev.instrument,prev.direction));});}} style={compactFld}/></div>
                    <div><label style={lblCompact}>{priceLabel} #{i+1}</label><input type="text" defaultValue={ex.price} onBlur={function(e){var val=e.target.value;st(function(prev){var ne=prev.exits.map(function(x,xi){return xi===i?Object.assign({},x,{price:val}):x;});return Object.assign({},prev,doRecalc(prev.entries||[],ne,prev.assetClass,prev.instrument,prev.direction));});}} style={compactFld}/></div>
                    <button onClick={function(){st(function(prev){var ne=prev.exits.filter(function(_,xi){return xi!==i;});return Object.assign({},prev,doRecalc(prev.entries||[],ne,prev.assetClass,prev.instrument,prev.direction));});}} style={{padding:density>=2?"6px 9px":"8px 10px",background:"#7f1d1d44",border:"1px solid #7f1d1d",borderRadius:6,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit",marginBottom:1}}>X</button>
                  </div>
                  {/* CHANGED: Per-leg time row — read-only display + Edit toggle. */}
                  <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,paddingLeft:2,fontSize:11}}>
                    <span style={{color:"#64748b",letterSpacing:0.5}}>Time:</span>
                    {isEditingTime
                      ?<input type="time" autoFocus defaultValue={tsToTimeStr(ex.time||Date.now())} onBlur={function(e){var v=e.target.value;st(function(prev){var ne=prev.exits.map(function(x,xi){return xi===i?Object.assign({},x,{time:applyTimeStrToTs(x.time,v)}):x;});return Object.assign({},prev,{exits:ne});});setEditingLegTime(null);}} style={Object.assign({},compactFld,{padding:"3px 6px",fontSize:11,width:90,colorScheme:"dark",color:"#e2e8f0"})}/>
                      :<span style={{color:"#cbd5e1",fontVariantNumeric:"tabular-nums"}}>{ex.time?fmtTime(new Date(ex.time)):"—"}</span>
                    }
                    {!isEditingTime&&<button onClick={function(){setEditingLegTime(legKey);}} style={{padding:"2px 8px",background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#94a3b8",fontSize:10,cursor:"pointer",fontFamily:"inherit",fontWeight:600,letterSpacing:0.3}}>Edit</button>}
                  </div>
                </div>
              );
            })}
            {remaining!==null&&exits.length>0&&(
              <div style={{marginTop:fldHeader,padding:"5px 10px",background:remaining===0?"#0f2a1c":"#1c1509",border:"1px solid "+(remaining===0?"#166534":"#713f12"),borderRadius:6,fontSize:density>=2?11:12,color:remaining===0?"#86efac":"#f59e0b",fontWeight:600}}>
                {remaining===0?"Fully closed":remaining+" "+(remaining===1?unitLabelSingular:unitLabel)+" still open"+(!isNaN(avgEntry)?" - $"+(remaining*avgEntry).toFixed(2)+" at risk":"")}
              </div>
            )}
          </div>
          {showPnL&&(
            <div style={{padding:density>=2?"5px 10px":"7px 12px",background:dollarPnl>=0?"#0f2a1c":"#2a0f0f",border:"1px solid "+(dollarPnl>=0?"#166534":"#7f1d1d"),borderRadius:8,marginBottom:sectionMb,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Total P&L</span>
              <span style={{fontSize:density>=2?15:18,fontWeight:700,color:dollarPnl>=0?"#22c55e":"#ef4444"}}>{dollarPnl>=0?"+":""}{$fmt(dollarPnl)}<span style={{fontSize:density>=2?11:12,fontWeight:500}}> ({pctPnlVal>=0?"+":""}{pctPnlVal.toFixed(2)}%)</span></span>
            </div>
          )}
          {/* ── SECTION: REVIEW ────────────────────────────────── */}
          <FormSection label="Review" mb={sectionMb} hasContent={!!(trade.grade||(trade.emotions||[]).length||(trade.violations||[]).length||trade.notes)}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:rowGap,marginBottom:fldHeader}}>
            <div>
              <label style={lblCompact}>Setup Grade</label>
              <div style={{display:"flex",gap:5}}>
                {["A","B","C"].map(function(g){return <button key={g} onClick={function(){upd("grade",g);}} style={{flex:1,padding:density>=2?"5px 0":"7px 0",background:trade.grade===g?(g==="A"?"#14532d":g==="B"?"#713f12":"#7f1d1d"):"#1e293b",border:"1px solid "+(trade.grade===g?(g==="A"?"#22c55e":g==="B"?"#f59e0b":"#ef4444"):"#334155"),borderRadius:6,color:trade.grade===g?"#fff":"#64748b",fontSize:density>=2?12:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{g}</button>;})}
              </div>
            </div>
            <MultiDropdown label="Emotional State" options={opts.emotion} selected={trade.emotions||[]} onChange={function(v){upd("emotions",v);}} negativeOptions={(opts.emotion||[]).filter(function(e){return getEmotionSentiment(e,opts.emotionSentiments||{})==="negative";})}/>
          </div>
          <div style={{marginBottom:sectionMb}}><MultiDropdown label="Rule Violations" options={opts.violation} selected={trade.violations||[]} onChange={function(v){upd("violations",v);}} negativeOptions={opts.violation}/></div>
          <div style={{marginBottom:sectionMb}}>
            <label style={lblCompact}>Quick Note</label>
            <input value={trade.notes} onChange={function(e){upd("notes",e.target.value);}} placeholder="Why did you take this trade?" style={Object.assign({},compactFld,{colorScheme:"dark",color:"#e2e8f0"})}/>
          </div>
          <div style={{marginBottom:0}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <label style={Object.assign({},lblCompact,{marginBottom:0})}>Screenshots {(trade.screenshots||[]).length>0&&<span style={{color:"#64748b",fontWeight:400,marginLeft:4}}>({(trade.screenshots||[]).length})</span>}</label>
              <button onClick={function(){if(screenshotInputRef.current)screenshotInputRef.current.click();}} disabled={uploadingShot} style={{padding:density>=2?"4px 10px":"5px 12px",background:uploadingShot?"#1e293b":"#0c2b3d",border:"1px solid "+(uploadingShot?"#334155":"#38bdf8"),borderRadius:6,color:uploadingShot?"#475569":"#38bdf8",fontSize:12,fontWeight:600,cursor:uploadingShot?"not-allowed":"pointer",fontFamily:"inherit"}}>{uploadingShot?"Uploading...":"+ Add Image"}</button>
            </div>
            <input ref={screenshotInputRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={function(e){
              var files=Array.from(e.target.files||[]);
              if(files.length===0)return;
              setShotError(null);setUploadingShot(true);
              Promise.all(files.map(function(f){return compressImage(f);}))
                .then(function(dataUrls){setTrade(function(t){return Object.assign({},t,{screenshots:(t.screenshots||[]).concat(dataUrls)});});setUploadingShot(false);})
                .catch(function(err){setShotError("Upload failed: "+(err.message||"unknown"));setUploadingShot(false);});
              e.target.value="";
            }}/>
            {shotError&&<div style={{fontSize:12,color:"#fca5a5",marginBottom:6}}>{shotError}</div>}
            {(trade.screenshots||[]).length>0&&(
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(80px,1fr))",gap:6}}>
                {(trade.screenshots||[]).map(function(src,si){
                  return (
                    <div key={si} style={{position:"relative",aspectRatio:"1",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,overflow:"hidden"}}>
                      <img src={src} alt={"Screenshot "+(si+1)} onClick={function(){setViewerShot(src);}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer",display:"block"}}/>
                      <button onClick={function(){setTrade(function(t){var copy=(t.screenshots||[]).slice();copy.splice(si,1);return Object.assign({},t,{screenshots:copy});});}} aria-label="Remove" style={{position:"absolute",top:3,right:3,width:18,height:18,padding:0,background:"#000000cc",border:"1px solid #475569",borderRadius:"50%",color:"#fca5a5",fontSize:11,cursor:"pointer",fontFamily:"inherit",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
            {(trade.screenshots||[]).length===0&&!uploadingShot&&<div style={{fontSize:11,color:"#64748b",fontStyle:"italic"}}>Optional. Images are compressed before saving.</div>}
          </div>
          </FormSection>
          </div>
        </div>
        <div style={{padding:"10px 14px",borderTop:"1px solid #1e293b",display:"flex",gap:8,flexShrink:0,background:"#0a0a0f",flexDirection:"column"}}>
          {totalEntryC>0&&totalExitC>0&&remaining<0&&(
            <div style={{padding:"6px 10px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:6,fontSize:11,color:"#fca5a5",textAlign:"center"}}>
              {Math.abs(remaining)+" extra exit "+(Math.abs(remaining)===1?unitLabelSingular:unitLabel)+" — exits exceed entries"}
            </div>
          )}
          {totalEntryC>0&&remaining>0&&totalExitC>0&&(
            <div style={{padding:"6px 10px",background:"#1c1108",border:"1px solid #ea580c",borderRadius:6,fontSize:11,color:"#fdba74",textAlign:"center"}}>
              Saving with {remaining} {remaining===1?unitLabelSingular:unitLabel} still open → moves to Live Trades
            </div>
          )}
          {totalEntryC>0&&totalExitC===0&&(
            <div style={{padding:"6px 10px",background:"#1c1108",border:"1px solid #ea580c",borderRadius:6,fontSize:11,color:"#fdba74",textAlign:"center"}}>
              No exits yet → saves as a Live Trade
            </div>
          )}
          {/* CHANGED: End of pretrade-checklist lock wrapper. Buttons sit outside so Cancel always works. */}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={onCancel} style={{flex:1,padding:"10px",background:"none",border:"1px solid #334155",borderRadius:8,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>Cancel</button>
            <button onClick={function(){if(!pretradeComplete)return;if(totalEntryC>0&&totalExitC>0&&remaining<0)return;onSave(trade);}} disabled={!pretradeComplete||(totalEntryC>0&&totalExitC>0&&remaining<0)} title={!pretradeComplete?"Complete pre-trade checklist first":""} style={{flex:2,padding:"10px",background:(!pretradeComplete||(totalEntryC>0&&totalExitC>0&&remaining<0))?"#1e293b":"#4f46e5",border:"none",borderRadius:8,color:(!pretradeComplete||(totalEntryC>0&&totalExitC>0&&remaining<0))?"#475569":"#fff",fontSize:13,cursor:(!pretradeComplete||(totalEntryC>0&&totalExitC>0&&remaining<0))?"not-allowed":"pointer",fontFamily:"inherit",fontWeight:700}}>{!pretradeComplete?"Locked":totalEntryC>0&&remaining===0?"Save Trade":totalEntryC>0?"Save as Live":"Save"}</button>
          </div>
        </div>
      </div>
      {viewerShot&&(
        <div onClick={function(){setViewerShot(null);}} style={{position:"fixed",inset:0,zIndex:2000,background:"#000000ee",display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",cursor:"pointer"}}>
          <img src={viewerShot} alt="Screenshot" style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",borderRadius:6}}/>
          <button aria-label="Close" style={{position:"absolute",top:14,right:14,width:36,height:36,padding:0,background:"#1e293b",border:"1px solid #475569",borderRadius:"50%",color:"#e2e8f0",fontSize:18,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>✕</button>
        </div>
      )}
    </div>
  );
}

function EconomicEvents(props){
  var reloadKey=props.reloadKey;
  var currencyFilter=props.currencyFilter,setCurrencyFilter=props.setCurrencyFilter;
  var impactFilter=props.impactFilter,setImpactFilter=props.setImpactFilter;
  var [events,setEvents]=useState([]);
  // CHANGED: Persist expanded state across re-renders so resync doesn't collapse the panel.
  var [expanded,setExpanded]=useState(function(){try{return localStorage.getItem("tf-events-expanded")==="1";}catch(e){return false;}});
  useEffect(function(){try{localStorage.setItem("tf-events-expanded",expanded?"1":"0");}catch(e){}},[expanded]);
  var [showAll,setShowAll]=useState(false);
  var [currencyOpen,setCurrencyOpen]=useState(false);
  var [impactOpen,setImpactOpen]=useState(false);
  function getCurrentWeekStart(){var now=getPT();var dow=now.getDay();var s=new Date(now.getFullYear(),now.getMonth(),now.getDate()-dow);s.setHours(0,0,0,0);return s;}
  useEffect(function(){maybeClearStaleEvents();setEvents(loadEvents());},[reloadKey]);
  useEffect(function(){var id=setInterval(function(){if(maybeClearStaleEvents())setEvents([]);},60000);return function(){clearInterval(id);};},[]);
  function normImpact(imp){var lvl=(imp||"").toLowerCase();if(lvl==="high"||lvl==="red")return "high";if(lvl==="medium"||lvl==="med"||lvl==="orange")return "medium";if(lvl==="low"||lvl==="yellow")return "low";if(lvl==="holiday"||lvl==="non-economic")return "holiday";return "none";}
  function impactStyle(imp){var n=normImpact(imp);if(n==="high")return {color:"#ef4444",label:"High"};if(n==="medium")return {color:"#f59e0b",label:"Med"};if(n==="low")return {color:"#22c55e",label:"Low"};if(n==="holiday")return {color:"#8b5cf6",label:"Holiday"};return {color:"#64748b",label:imp||"—"};}
  if(events.length===0){
    return (
      <div style={Object.assign(CS({marginBottom:16}),{border:"1px solid #713f12",background:"#1c1509"})}>
        <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
          <div style={{fontSize:21,lineHeight:1,flexShrink:0}}>⚠</div>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:700,color:"#f59e0b",marginBottom:4}}>Upload this week's economic events</div>
            <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.5,marginBottom:10}}>No events loaded for the current week. Import a JSON file or paste the data from your calendar source.</div>
            {props.onNavigateToSettings&&<button onClick={props.onNavigateToSettings} style={{padding:"7px 14px",background:"#713f12",border:"1px solid #f59e0b",borderRadius:6,color:"#fbbf24",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Go to Settings →</button>}
          </div>
        </div>
      </div>
    );
  }
  var weekStart=getCurrentWeekStart();
  var weekEnd=new Date(weekStart);weekEnd.setDate(weekStart.getDate()+7);
  var weekEvents=events.map(function(e){return Object.assign({},e,{_d:parseEventDate(e)});}).filter(function(e){return e._d&&e._d>=weekStart&&e._d<weekEnd;});
  var currencies={};events.forEach(function(e){var c=eventCurrency(e);if(c)currencies[c]=true;});
  var currencyList=Object.keys(currencies).sort();
  var availableImpacts={};weekEvents.forEach(function(e){var n=normImpact(e.impact);if(n!=="none")availableImpacts[n]=true;});
  if(currencyFilter.length>0)weekEvents=weekEvents.filter(function(e){return currencyFilter.indexOf(eventCurrency(e))>=0;});
  if(impactFilter.length>0)weekEvents=weekEvents.filter(function(e){return impactFilter.indexOf(normImpact(e.impact))>=0;});
  weekEvents.sort(function(a,b){return a._d-b._d;});
  var now=getPT();
  var displayEvents=showAll?weekEvents:weekEvents.filter(function(e){var ds=e._d.toLocaleDateString("en-US");return ds===todayStr()||e._d>=now;}).slice(0,8);
  function formatEventTime(d){var h=d.getHours(),m=d.getMinutes();if(h===0&&m===0)return "All day";return (h%12||12)+":"+(m<10?"0"+m:m)+" "+(h>=12?"PM":"AM");}
  function groupByDay(evts){var groups=[],lastKey=null;evts.forEach(function(e){var key=e._d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});if(key!==lastKey){groups.push({label:key,dateStr:e._d.toLocaleDateString("en-US"),events:[]});lastKey=key;}groups[groups.length-1].events.push(e);});return groups;}
  var grouped=groupByDay(displayEvents);
  function weekLabel(){var endDisplay=new Date(weekStart);endDisplay.setDate(weekStart.getDate()+6);var sameMonth=weekStart.getMonth()===endDisplay.getMonth();var s=weekStart.toLocaleDateString("en-US",{month:"short",day:"numeric"});var e=sameMonth?endDisplay.getDate():endDisplay.toLocaleDateString("en-US",{month:"short",day:"numeric"});return s+" – "+e;}
  function toggleImpact(lvl){setImpactFilter(function(arr){return arr.indexOf(lvl)>=0?arr.filter(function(x){return x!==lvl;}):arr.concat([lvl]);});}
  function toggleCurrency(c){setCurrencyFilter(function(arr){return arr.indexOf(c)>=0?arr.filter(function(x){return x!==c;}):arr.concat([c]);});}
  var allImpactLevels=[{id:"high",label:"High",color:"#ef4444"},{id:"medium",label:"Medium",color:"#f59e0b"},{id:"low",label:"Low",color:"#22c55e"}];
  if(availableImpacts.holiday||impactFilter.indexOf("holiday")>=0)allImpactLevels.push({id:"holiday",label:"Holiday",color:"#8b5cf6"});
  return (
    <div style={CS({marginBottom:16})}>
      {/* CHANGED: Whole header row is clickable to expand/collapse. Filter cluster stops propagation so its own clicks don't toggle the panel. */}
      <div onClick={function(){setExpanded(function(e){return !e;});}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:expanded?12:8,position:"relative",cursor:"pointer"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          <span style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Economic Events</span>
          <span style={{fontSize:12,color:"#475569"}}>{weekEvents.length}</span>
        </div>
        <div onClick={function(e){e.stopPropagation();}} style={{display:"flex",alignItems:"center",gap:6,flexShrink:0,justifyContent:"flex-end"}}>
          {currencyList.length>=1&&(
            <div style={{position:"relative"}}>
              <button onClick={function(){setCurrencyOpen(function(o){return !o;});setImpactOpen(false);}} style={{padding:"4px 9px",background:currencyFilter.length>0?"#1e1b4b":"#0a0a0f",border:"1px solid "+(currencyFilter.length>0?"#4338ca":"#334155"),borderRadius:4,color:currencyFilter.length>0?"#a5b4fc":"#94a3b8",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4,maxWidth:130,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                <span style={{overflow:"hidden",textOverflow:"ellipsis"}}>{currencyFilter.length===0||currencyFilter.length===currencyList.length?"All FX":currencyFilter.length===1?currencyFilter[0]:currencyFilter.length+" FX"}</span>
                <span style={{fontSize:9,color:"#64748b"}}>▾</span>
              </button>
              {currencyOpen&&(
                <div style={{position:"absolute",top:"100%",right:0,minWidth:180,background:"#1e293b",border:"1px solid #334155",borderRadius:8,zIndex:200,overflow:"hidden",boxShadow:"0 8px 24px #00000066",marginTop:4,maxHeight:280,overflowY:"auto"}}>
                  {currencyFilter.length>0&&<button onClick={function(){setCurrencyFilter([]);setCurrencyOpen(false);}} style={{width:"100%",padding:"7px 12px",background:"transparent",border:"none",borderBottom:"1px solid #334155",color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit",textAlign:"left",fontStyle:"italic"}}>Clear</button>}
                  {currencyList.map(function(c,i){
                    var sel=currencyFilter.indexOf(c)>=0;
                    return <button key={c} onClick={function(){toggleCurrency(c);}} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:sel?"#1e1b4b":"transparent",border:"none",borderBottom:i<currencyList.length-1?"1px solid #334155":"none",color:sel?"#a5b4fc":"#cbd5e1",fontSize:13,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                      <div style={{width:13,height:13,borderRadius:3,border:"2px solid "+(sel?"#6366f1":"#475569"),background:sel?"#6366f1":"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#fff",flexShrink:0}}>{sel?"✓":""}</div>
                      {c}
                    </button>;
                  })}
                </div>
              )}
            </div>
          )}
          <div style={{position:"relative"}}>
            <button onClick={function(){setImpactOpen(function(o){return !o;});setCurrencyOpen(false);}} style={{padding:"4px 9px",background:impactFilter.length>0?"#1e1b4b":"#0a0a0f",border:"1px solid "+(impactFilter.length>0?"#4338ca":"#334155"),borderRadius:4,color:impactFilter.length>0?"#a5b4fc":"#94a3b8",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:4}}>
              <span>{impactFilter.length===0||impactFilter.length===allImpactLevels.length?"All impact":impactFilter.length===1?impactFilter[0].charAt(0).toUpperCase()+impactFilter[0].slice(1):impactFilter.length+" levels"}</span>
              <span style={{fontSize:9,color:"#64748b"}}>▾</span>
            </button>
            {impactOpen&&(
              <div style={{position:"absolute",top:"100%",right:0,minWidth:170,background:"#1e293b",border:"1px solid #334155",borderRadius:8,zIndex:200,overflow:"hidden",boxShadow:"0 8px 24px #00000066",marginTop:4}}>
                {impactFilter.length>0&&<button onClick={function(){setImpactFilter([]);setImpactOpen(false);}} style={{width:"100%",padding:"7px 12px",background:"transparent",border:"none",borderBottom:"1px solid #334155",color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit",textAlign:"left",fontStyle:"italic"}}>Clear</button>}
                {allImpactLevels.map(function(lvl,i){
                  var sel=impactFilter.indexOf(lvl.id)>=0;
                  return <button key={lvl.id} onClick={function(){toggleImpact(lvl.id);}} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 12px",background:sel?"#1e1b4b":"transparent",border:"none",borderBottom:i<allImpactLevels.length-1?"1px solid #334155":"none",color:sel?"#a5b4fc":"#cbd5e1",fontSize:13,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                    <div style={{width:13,height:13,borderRadius:3,border:"2px solid "+(sel?lvl.color:"#475569"),background:sel?lvl.color:"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#fff",flexShrink:0}}>{sel?"✓":""}</div>
                    <span style={{width:6,height:6,borderRadius:"50%",background:lvl.color,flexShrink:0}}/>
                    {lvl.label}
                  </button>;
                })}
              </div>
            )}
          </div>
          <svg onClick={function(){setExpanded(function(e){return !e;});}} width="12" height="12" viewBox="0 0 12 12" fill="none" style={{cursor:"pointer",display:"inline-block",verticalAlign:"middle",transition:"transform 0.2s",transform:expanded?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
      </div>
      {!expanded&&(function(){
        var todayDateStr=todayStr();
        var tomorrowD=new Date();tomorrowD.setDate(tomorrowD.getDate()+1);
        var tomorrowDateStr=tomorrowD.toLocaleDateString("en-US");
        var todayEvents=weekEvents.filter(function(e){return e._d&&e._d.toLocaleDateString("en-US")===todayDateStr;});
        var tomorrowEvents=weekEvents.filter(function(e){return e._d&&e._d.toLocaleDateString("en-US")===tomorrowDateStr;});
        if(todayEvents.length===0&&tomorrowEvents.length===0)return <div style={{fontSize:13,color:"#475569",textAlign:"center",padding:"4px 0",fontStyle:"italic"}}>No events today or tomorrow{(currencyFilter.length>0||impactFilter.length>0)?" matching filters":""}</div>;
        var renderEvent=function(e,ei){
          var imp=impactStyle(e.impact);
          var cur=eventCurrency(e);
          return (
            <div key={ei} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:"#0a0a0f",borderRadius:6,marginBottom:3,border:"1px solid #1e293b"}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:imp.color,flexShrink:0}}/>
              <span style={{fontSize:12,color:"#64748b",minWidth:54}}>{formatEventTime(e._d)}</span>
              {cur&&<span style={{fontSize:10,padding:"1px 5px",borderRadius:3,background:"#1e293b",color:"#cbd5e1",fontWeight:700}}>{cur}</span>}
              <span style={{fontSize:13,color:"#e2e8f0",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.event||e.title||"Event"}</span>
              {(e.forecast||e.previous)&&<span style={{fontSize:10,color:"#64748b",flexShrink:0}}>{e.forecast?"F: "+e.forecast:""}{e.forecast&&e.previous?" · ":""}{e.previous?"P: "+e.previous:""}</span>}
            </div>
          );
        };
        return (
          <div>
            <div style={{fontSize:12,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:5}}>Today</div>
            {todayEvents.length===0?<div style={{fontSize:12,color:"#64748b",fontStyle:"italic",padding:"4px 0 8px"}}>No events</div>:todayEvents.map(renderEvent)}
            <div style={{fontSize:12,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:5,marginTop:10}}>Tomorrow</div>
            {tomorrowEvents.length===0?<div style={{fontSize:12,color:"#64748b",fontStyle:"italic",padding:"4px 0"}}>No events</div>:tomorrowEvents.map(renderEvent)}
          </div>
        );
      })()}
      {expanded&&(
        <div>
          <div style={{textAlign:"center",marginBottom:10}}>
            <span style={{fontSize:14,fontWeight:700,color:"#a5b4fc"}}>{weekLabel()}</span>
          </div>
          {displayEvents.length===0&&<div style={{fontSize:14,color:"#475569",textAlign:"center",padding:"16px 0"}}>No events match your filters for this week</div>}
          {grouped.map(function(g,gi){
            var isToday=g.dateStr===todayStr();
            return (
              <div key={gi} style={{marginBottom:10}}>
                <div style={{fontSize:12,color:isToday?"#a5b4fc":"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:5}}>{isToday?"Today · "+g.label:g.label}</div>
                {g.events.map(function(e,ei){
                  var imp=impactStyle(e.impact);
                  var cur=eventCurrency(e);
                  return (
                    <div key={ei} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:"#0a0a0f",borderRadius:6,marginBottom:3,border:"1px solid #1e293b"}}>
                      <div style={{width:6,height:6,borderRadius:"50%",background:imp.color,flexShrink:0}}/>
                      <span style={{fontSize:12,color:"#64748b",minWidth:54}}>{formatEventTime(e._d)}</span>
                      {cur&&<span style={{fontSize:10,padding:"1px 5px",borderRadius:3,background:"#1e293b",color:"#cbd5e1",fontWeight:700}}>{cur}</span>}
                      <span style={{fontSize:13,color:"#e2e8f0",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.event||e.title||"Event"}</span>
                      {(e.forecast||e.previous)&&<span style={{fontSize:10,color:"#64748b",flexShrink:0}}>{e.forecast?"F: "+e.forecast:""}{e.forecast&&e.previous?" · ":""}{e.previous?"P: "+e.previous:""}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {weekEvents.length>displayEvents.length&&!showAll&&<button onClick={function(){setShowAll(true);}} style={{width:"100%",padding:"6px",background:"none",border:"1px dashed #334155",borderRadius:6,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",marginTop:4}}>Show all {weekEvents.length} events this week</button>}
          {showAll&&weekEvents.length>8&&<button onClick={function(){setShowAll(false);}} style={{width:"100%",padding:"6px",background:"none",border:"1px dashed #334155",borderRadius:6,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",marginTop:4}}>Show upcoming only</button>}
        </div>
      )}
    </div>
  );
}

// CHANGED: Notebook — collates every written note across the journal: each trade's notes plus the
// end-of-day note, grouped by date (newest first). A readable log of your thinking over time.
function NotebookPanel(props){
  // CHANGED: Persist open state — survives re-renders / resyncs.
  var [open,setOpen]=useState(function(){try{return localStorage.getItem("tf-notebook-open")==="1";}catch(e){return false;}});
  useEffect(function(){try{localStorage.setItem("tf-notebook-open",open?"1":"0");}catch(e){}},[open]);
  var [viewer,setViewer]=useState(null);
  var [sortMode,setSortMode]=useState("date_desc"); // CHANGED: date_desc | date_asc | pnl_desc | pnl_asc
  // Build dated entries. props.todayState lets today's in-progress notes appear before the day is saved.
  var rows=loadJournalRows().slice();
  var byDate={};
  rows.forEach(function(r){byDate[r.date]=r;});
  // Merge today's live state so unsaved notes still show.
  var ts=props.todayState;
  if(ts&&ts.date){
    var existing=byDate[ts.date]||{};
    byDate[ts.date]=Object.assign({},existing,{date:ts.date,trades:ts.trades&&ts.trades.length?ts.trades:(existing.trades||[]),note:ts.dailyNote!=null&&ts.dailyNote!==""?ts.dailyNote:(existing.note||"")});
  }
  var dates=Object.keys(byDate);
  // Keep only dates that actually have written content.
  var entries=dates.map(function(d){
    var r=byDate[d];
    var tradeNotes=(r.trades||[]).filter(function(t){return t&&t.notes&&t.notes.trim();}).map(function(t){
      return {instrument:t.instrument||"",direction:t.direction||"",time:t.time||"",pnl:t.pnl,note:t.notes.trim(),screenshots:(t.screenshots||[]).slice()};
    });
    var dayNote=(r.note||"").trim();
    // CHANGED: Half-size lock reflection (`lockNote`) saved from the discipline lock banner also
    // belongs in the Notebook — it's a written note like any other.
    var lockNote=(r.lockNote||"").trim();
    // Day P&L from all closed trades (for the P&L sort), independent of which trades have notes.
    var dayPnl=(r.trades||[]).reduce(function(s,t){return s+((t&&t.status!=="open")?(parseFloat(t.pnl)||0):0);},0);
    return {date:d,tradeNotes:tradeNotes,dayNote:dayNote,lockNote:lockNote,dayPnl:dayPnl};
  }).filter(function(e){return e.tradeNotes.length>0||e.dayNote||e.lockNote;});
  // CHANGED: Apply the chosen sort — by date or by day P&L, asc or desc.
  entries.sort(function(a,b){
    if(sortMode==="pnl_desc")return b.dayPnl-a.dayPnl;
    if(sortMode==="pnl_asc")return a.dayPnl-b.dayPnl;
    if(sortMode==="date_asc")return new Date(a.date)-new Date(b.date);
    return new Date(b.date)-new Date(a.date); // date_desc default
  });
  var totalNotes=entries.reduce(function(s,e){return s+e.tradeNotes.length+(e.dayNote?1:0)+(e.lockNote?1:0);},0);
  function fmtDate(ds){try{var d=new Date(ds);return d.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"});}catch(e){return ds;}}
  return (
    <div style={{marginTop:16,marginBottom:16,border:"1px solid #1e293b",borderRadius:12,background:"#0d0d12",overflow:"hidden"}}>
      <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"none",border:"none",padding:"14px 16px",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <span style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>📓 Notebook</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:"#475569"}}>{totalNotes} note{totalNotes===1?"":"s"} · {entries.length} day{entries.length===1?"":"s"}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
      </button>
      {open&&(
        <div style={{padding:"0 16px 16px"}}>
          {entries.length>0&&(
            <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>
              <button onClick={function(){setSortMode(function(m){return m==="date_desc"?"date_asc":m==="date_asc"?"pnl_desc":m==="pnl_desc"?"pnl_asc":"date_desc";});}} style={{padding:"4px 10px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>{(function(){var lbl={date_desc:"Newest first",date_asc:"Oldest first",pnl_desc:"Highest P&L",pnl_asc:"Lowest P&L"};var arrow={date_desc:"↓",date_asc:"↑",pnl_desc:"↓",pnl_asc:"↑"};return <>Sort: {lbl[sortMode]} <span style={{fontSize:9}}>{arrow[sortMode]}</span></>;})()}</button>
            </div>
          )}
          {entries.length===0&&<div style={{fontSize:13,color:"#64748b",fontStyle:"italic",padding:"8px 0"}}>No notes yet. Trade notes and end-of-day notes will collect here.</div>}
          {entries.map(function(e){
            return (
              <div key={e.date} style={{marginBottom:18}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,paddingBottom:4,borderBottom:"1px solid #1e293b"}}>
                  <span style={{fontSize:12,color:"#a5b4fc",fontWeight:700,letterSpacing:0.5}}>{fmtDate(e.date)}</span>
                  {e.dayPnl!==0&&!HIDE_DOLLAR_PNL&&<span style={{fontSize:11,fontWeight:700,color:e.dayPnl>=0?"#86efac":"#fca5a5",fontVariantNumeric:"tabular-nums"}}>{(e.dayPnl>=0?"+$":"-$")+Math.abs(e.dayPnl).toFixed(0)}</span>}
                </div>
                {e.tradeNotes.map(function(tn,ti){
                  var pnlNum=parseFloat(tn.pnl);
                  var pnlStr=(!isNaN(pnlNum)&&tn.pnl!=="")?(HIDE_DOLLAR_PNL?"":((pnlNum>=0?"+$":"-$")+Math.abs(pnlNum).toFixed(0))):"";
                  return (
                    <div key={ti} style={{marginBottom:10,paddingLeft:10,borderLeft:"3px solid #334155"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2,flexWrap:"wrap"}}>
                        {tn.instrument&&<span style={{fontSize:12,fontWeight:700,color:"#cbd5e1"}}>{tn.instrument}</span>}
                        {tn.direction&&<span style={{fontSize:10,color:getDirectionColor(tn.direction),fontWeight:700}}>{tn.direction}</span>}
                        {tn.time&&<span style={{fontSize:10,color:"#64748b"}}>{tn.time}</span>}
                        {pnlStr&&<span style={{fontSize:10,color:parseFloat(tn.pnl)>=0?"#86efac":"#fca5a5",fontWeight:600,marginLeft:"auto"}}>{pnlStr}</span>}
                      </div>
                      <div style={{fontSize:13,color:"#cbd5e1",fontStyle:"italic",lineHeight:1.5}}>{tn.note}</div>
                      {(tn.screenshots||[]).length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:8}}>{tn.screenshots.map(function(src,si){return <img key={si} src={src} alt={"Screenshot "+(si+1)} onClick={function(){setViewer(src);}} style={{width:56,height:56,objectFit:"cover",borderRadius:5,border:"1px solid #334155",cursor:"pointer",display:"block"}}/>;})}</div>}
                    </div>
                  );
                })}
                {e.dayNote&&(
                  <div style={{marginTop:e.tradeNotes.length>0?10:0,padding:"8px 11px",background:"#0a0a0f",borderLeft:"3px solid #4338ca",borderRadius:"0 5px 5px 0"}}>
                    <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:0.5,marginBottom:3,fontWeight:600}}>End-of-day</div>
                    <div style={{fontSize:13,color:"#cbd5e1",lineHeight:1.5}}>{e.dayNote}</div>
                  </div>
                )}
                {e.lockNote&&(
                  <div style={{marginTop:(e.tradeNotes.length>0||e.dayNote)?10:0,padding:"8px 11px",background:"#0a0a0f",borderLeft:"3px solid #7f1d1d",borderRadius:"0 5px 5px 0"}}>
                    <div style={{fontSize:10,color:"#fca5a5",textTransform:"uppercase",letterSpacing:0.5,marginBottom:3,fontWeight:600}}>Half-size reflection</div>
                    <div style={{fontSize:13,color:"#cbd5e1",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{e.lockNote}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {viewer&&(
        <div onClick={function(){setViewer(null);}} style={{position:"fixed",inset:0,background:"#000000ee",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20,cursor:"pointer"}}>
          <img src={viewer} alt="Screenshot" style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",borderRadius:6}}/>
        </div>
      )}
    </div>
  );
}

// CHANGED: Photo Gallery — collates all trade screenshots from journal into a collapsible grid with lightbox.
function PhotoGallery(props){
  var [open,setOpen]=useState(false);
  var [lightbox,setLightbox]=useState(null);
  function fmtD(ds){try{var d=new Date(ds);if(isNaN(d.getTime()))return ds;return (d.getMonth()+1)+"/"+d.getDate();}catch(e){return ds;}}
  // Gather screenshots. When `trades` is provided (e.g. the Journal's filtered+sorted list),
  // build the gallery from those trades in their given order so Sort/Filter carry over.
  // Otherwise fall back to collecting all screenshots across the whole journal.
  var shots=[];
  try{
    if(Array.isArray(props.trades)){
      var galDate=props.galleryDate||todayStr();
      props.trades.forEach(function(t){
        if(t.status==="open")return;
        (t.screenshots||[]).forEach(function(src){shots.push({src:src,date:t.date||galDate,openedAt:parseFloat(t.openedAt)||0,instrument:t.instrument||"",pnl:t.pnl,pctPnl:t.pctPnl,setup:t.setup||""});});
      });
    }else{
      loadJournalRows().forEach(function(entry){
        (entry.trades||[]).forEach(function(t){
          (t.screenshots||[]).forEach(function(src){shots.push({src:src,date:entry.date,openedAt:parseFloat(t.openedAt)||0,instrument:t.instrument||"",pnl:t.pnl,pctPnl:t.pctPnl,setup:t.setup||""});});
        });
      });
      (props.todayTrades||[]).forEach(function(t){
        if(t.status==="open")return;
        (t.screenshots||[]).forEach(function(src){shots.push({src:src,date:todayStr(),openedAt:parseFloat(t.openedAt)||0,instrument:t.instrument||"",pnl:t.pnl,pctPnl:t.pctPnl,setup:t.setup||""});});
      });
      // CHANGED: Sort chronologically — by date, then by trade open time. Skipped when a
      // pre-ordered trades list is supplied (the Journal already applied its own sort).
      shots.sort(function(a,b){
        var da=new Date(a.date).getTime()||0,db=new Date(b.date).getTime()||0;
        if(da!==db)return da-db;
        return a.openedAt-b.openedAt;
      });
    }
  }catch(e){}
  if(shots.length===0)return null;
  var galleryTitle=props.title||"Screenshots";
  var alwaysOpen=!!props.alwaysOpen;
  var expanded=alwaysOpen||open;
  return (
    <div style={{marginBottom:16,background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:10,overflow:"hidden"}}>
      {alwaysOpen?(
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px"}}>
          <span style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>{galleryTitle} <span style={{fontSize:12,color:"#64748b",fontWeight:400}}>({shots.length})</span></span>
        </div>
      ):(
        <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit"}}>
          <span style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>{galleryTitle} <span style={{fontSize:12,color:"#64748b",fontWeight:400}}>({shots.length})</span></span>
          <span style={{fontSize:12,color:"#64748b"}}>{open?"▴":"▾"}</span>
        </button>
      )}
      {expanded&&(
        <div style={{padding:"0 12px 12px"}}>
          <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:6,WebkitOverflowScrolling:"touch",scrollbarWidth:"thin"}}>
            {shots.map(function(shot,i){
              var pnlNum=parseFloat(shot.pnl);
              var border=isNaN(pnlNum)?"#1e293b":(pnlNum>=0?"#16653488":"#7f1d1d88");
              return (
                <button key={i} onClick={function(){setLightbox(i);}} style={{position:"relative",width:120,height:120,flexShrink:0,padding:0,border:"1px solid "+border,borderRadius:6,overflow:"hidden",cursor:"pointer",background:"#000"}}>
                  <img src={shot.src} alt="" style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}} draggable={false}/>
                  <div style={{position:"absolute",bottom:0,left:0,right:0,padding:"3px 5px",background:"linear-gradient(transparent,#000000dd)",fontSize:9,color:"#cbd5e1",textAlign:"left"}}>{fmtD(shot.date)}{shot.instrument?" · "+shot.instrument:""}{!isNaN(parseFloat(shot.pctPnl))?<span style={{color:parseFloat(shot.pctPnl)>=0?"#86efac":"#fca5a5",fontWeight:700,marginLeft:4}}>{(parseFloat(shot.pctPnl)>=0?"+":"")+parseFloat(shot.pctPnl).toFixed(2)+"%"}</span>:null}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {lightbox!=null&&shots[lightbox]&&(function(){
        var L=shots[lightbox];
        var hasPrev=lightbox>0,hasNext=lightbox<shots.length-1;
        return (
          <div onClick={function(){setLightbox(null);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:500,background:"#000000ee",display:"flex",alignItems:"center",justifyContent:"center",padding:16,flexDirection:"column",gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10,maxWidth:"100%"}} onClick={function(e){e.stopPropagation();}}>
              <button onClick={function(){if(hasPrev)setLightbox(lightbox-1);}} disabled={!hasPrev} style={{width:36,height:36,flexShrink:0,background:hasPrev?"#1e293b":"#1e293b44",border:"1px solid #475569",borderRadius:"50%",color:hasPrev?"#cbd5e1":"#475569",fontSize:18,cursor:hasPrev?"pointer":"default",fontFamily:"inherit",lineHeight:1}}>‹</button>
              <img src={L.src} alt="" style={{maxWidth:"calc(100% - 92px)",maxHeight:"78vh",objectFit:"contain",borderRadius:8}}/>
              <button onClick={function(){if(hasNext)setLightbox(lightbox+1);}} disabled={!hasNext} style={{width:36,height:36,flexShrink:0,background:hasNext?"#1e293b":"#1e293b44",border:"1px solid #475569",borderRadius:"50%",color:hasNext?"#cbd5e1":"#475569",fontSize:18,cursor:hasNext?"pointer":"default",fontFamily:"inherit",lineHeight:1}}>›</button>
            </div>
            <div style={{fontSize:13,color:"#cbd5e1",textAlign:"center"}} onClick={function(e){e.stopPropagation();}}>
              {fmtD(L.date)}{L.instrument?" · "+L.instrument:""}{L.setup?" · "+L.setup:""}
              {(!isNaN(parseFloat(L.pctPnl))||!isNaN(parseFloat(L.pnl)))&&(function(){
                var pc=parseFloat(L.pctPnl),dl=parseFloat(L.pnl);
                var pos=!isNaN(pc)?pc>=0:dl>=0;
                var parts=[];
                if(!isNaN(pc))parts.push((pc>=0?"+":"")+pc.toFixed(2)+"%");
                if(!HIDE_DOLLAR_PNL&&!isNaN(dl))parts.push((dl>=0?"+$":"-$")+Math.abs(dl).toFixed(2));
                return <span style={{color:pos?"#22c55e":"#ef4444",fontWeight:700,marginLeft:6}}>{parts.join(" · ")}</span>;
              })()}
              <span style={{color:"#64748b",marginLeft:8}}>{lightbox+1}/{shots.length}</span>
            </div>
            <button onClick={function(){setLightbox(null);}} style={{padding:"6px 16px",background:"#1e293b",border:"1px solid #475569",borderRadius:6,color:"#cbd5e1",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Close</button>
          </div>
        );
      })()}
    </div>
  );
}
// CHANGED: Scroll-window for the scale milestones grid. Shows ~7 rows at once; on mount,
// scrolls so the current tier sits centered within the visible band. The sticky header is
// rendered outside the scrollable grid so it fully covers anything scrolling behind it.
function ScaleMilestonesScroller(props){
  var scrollRef=useRef(null);
  var headerH=22; // px — height of the sticky header bar; subtracted when centering.
  useEffect(function(){
    var c=scrollRef.current;if(!c)return;
    var el=c.querySelector('[data-tier="'+props.currentTier+'"]');
    if(!el)return;
    // Use bounding-rect math — robust against offsetParent surprises and grid layout.
    var cRect=c.getBoundingClientRect();
    var eRect=el.getBoundingClientRect();
    var offsetWithinScroller=(eRect.top-cRect.top)+c.scrollTop;
    var visibleH=c.clientHeight-headerH;
    c.scrollTop=Math.max(0,offsetWithinScroller-headerH-(visibleH/2)+(eRect.height/2));
  },[props.currentTier]);
  return (
    <div style={{position:"relative",border:"1px solid #1e293b",borderRadius:4,background:"#0a0a0f"}}>
      {/* CHANGED: Sticky header rendered OUTSIDE the scroll container as a single solid bar so
         no tier rows can ever leak through the gap between cells. */}
      <div style={{display:"grid",gridTemplateColumns:"auto 1fr 1fr",gap:6,background:"#0a0a0f",borderBottom:"1px solid #1e293b",padding:"4px 4px"}}>
        <div style={{fontSize:9,color:"#64748b",letterSpacing:0.5,textTransform:"uppercase",fontWeight:600,padding:"2px 6px"}}>Tier</div>
        <div style={{fontSize:9,color:"#64748b",letterSpacing:0.5,textTransform:"uppercase",fontWeight:600,padding:"2px 6px"}}>Position (min–max)</div>
        <div style={{fontSize:9,color:"#64748b",letterSpacing:0.5,textTransform:"uppercase",fontWeight:600,padding:"2px 6px"}}>Risk (min–max)</div>
      </div>
      <div ref={scrollRef} style={{maxHeight:176,overflowY:"auto",padding:"2px 4px",position:"relative"}}>
        {props.children}
      </div>
    </div>
  );
}

// CHANGED: Standalone scaling/account balance card. Was previously inline in PerformanceTab;
// moved here so it can render in the Progress widget on the dashboard instead.
function ScalingTargetCard(props){
  var settings=props.settings||{};
  var liveTotalPnL=props.liveTotalPnL||0;
  var balance=computeAccountBalance(liveTotalPnL);
  // CHANGED: Target is auto-derived as the next tier in the scaling-milestone schedule (matches
  // Settings → Auto-Sizing Parameters → Scale Milestones). No dropdown, nothing to configure.
  var milestones=[500];
  for(var k=1;k<=10;k++)milestones.push(k*1000);
  milestones.push(15000);milestones.push(20000);
  for(var m10=30000;m10<=100000;m10+=10000)milestones.push(m10);
  var targetVal=milestones.find(function(m){return m>balance;})||milestones[milestones.length-1];
  // CHANGED: Position Now sizes use the CURRENT TIER (largest milestone ≤ balance), not the raw
  // balance — the live trade-sizing logic bands to the current tier so values stay stable across
  // each band. Without this, the card disagrees with the Settings preview which IS banded.
  var currentTier=(function(){var t=milestones[0];for(var i=0;i<milestones.length;i++){if(milestones[i]<=balance)t=milestones[i];else break;}return t;})();
  var pctToTarget=targetVal>0?Math.min(100,Math.max(0,(balance/targetVal)*100)):0;
  var reached=targetVal>0&&balance>=targetVal;
  var slip=settings.slippagePct!=null?settings.slippagePct:20;
  var posMaxPct=settings.positionMaxPct!=null?settings.positionMaxPct:7.5;
  var riskMaxPct=settings.riskMaxPct!=null?settings.riskMaxPct:33;
  var sizesAtTarget=calcPosSizes(targetVal,{sizingMode:settings.sizingMode,slippagePct:slip,positionMaxPct:posMaxPct,riskMaxPct:riskMaxPct,positionMaxDollar:settings.positionMaxDollar,riskMaxDollar:settings.riskMaxDollar});
  var sizesNow=calcPosSizes(currentTier,{sizingMode:settings.sizingMode,slippagePct:slip,positionMaxPct:posMaxPct,riskMaxPct:riskMaxPct,positionMaxDollar:settings.positionMaxDollar,riskMaxDollar:settings.riskMaxDollar});
  function fmtUSD(v){return "$"+v.toLocaleString("en-US",{maximumFractionDigits:0});}
  function fmtPnLUSD(v){if(HIDE_DOLLAR_PNL)return "$•••";return "$"+v.toLocaleString("en-US",{maximumFractionDigits:0});}
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"#0d0d12",border:"1px solid "+(reached?"#166534":"#1e293b"),borderRadius:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:8,flexWrap:"wrap"}}>
        <div style={{fontSize:10,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Account Balance</div>
        <div style={{fontSize:10,color:"#64748b",letterSpacing:0.5,fontWeight:600}}>Next tier</div>
      </div>
      <div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:10,flexWrap:"wrap"}}>
        <div style={{fontSize:26,fontWeight:800,color:reached?"#22c55e":"#818cf8",letterSpacing:-0.5,fontVariantNumeric:"tabular-nums"}}>{fmtPnLUSD(balance)}</div>
        <div style={{fontSize:12,color:"#94a3b8"}}>of <span style={{color:reached?"#86efac":"#cbd5e1",fontWeight:700}}>{fmtPnLUSD(targetVal)}</span> target</div>
      </div>
      <div style={{height:8,background:"#0a0a0f",borderRadius:4,overflow:"hidden",marginBottom:6}}>
        <div style={{height:"100%",width:pctToTarget+"%",background:reached?"#22c55e":"#6366f1",transition:"width 0.4s"}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#94a3b8",marginBottom:10,fontWeight:600}}>
        <span style={{fontVariantNumeric:"tabular-nums"}}>{pctToTarget.toFixed(1)}%</span>
        <span style={{color:reached?"#86efac":"#cbd5e1"}}>{reached?"✓ Milestone reached":fmtPnLUSD(Math.max(0,targetVal-balance))+" to go"}</span>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,paddingTop:10,borderTop:"1px solid #1e293b"}}>
        <div style={{background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:6,padding:"8px 10px"}}>
          <div style={{fontSize:9,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Position now</div>
          <div style={{fontSize:13,fontWeight:700,color:"#818cf8",marginTop:3,fontVariantNumeric:"tabular-nums"}}>{fmtUSD(sizesNow.positionMin)}–{fmtUSD(sizesNow.positionMax)}</div>
          <div style={{fontSize:10,color:"#94a3b8",marginTop:2}}>Risk {fmtUSD(sizesNow.riskMax)}</div>
        </div>
        <div style={{background:"#0a0a0f",border:"1px solid "+(reached?"#166534":"#1e293b"),borderRadius:6,padding:"8px 10px"}}>
          <div style={{fontSize:9,color:reached?"#86efac":"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>At target</div>
          <div style={{fontSize:13,fontWeight:700,color:reached?"#86efac":"#cbd5e1",marginTop:3,fontVariantNumeric:"tabular-nums"}}>{fmtUSD(sizesAtTarget.positionMin)}–{fmtUSD(sizesAtTarget.positionMax)}</div>
          <div style={{fontSize:10,color:"#94a3b8",marginTop:2}}>Risk {fmtUSD(sizesAtTarget.riskMax)}</div>
        </div>
      </div>
    </div>
  );
}

function GamificationWidget(props){
  var includeToday=props.includeToday||false;
  var rows=loadJournalRows();
  var streak=calculateStreak(includeToday);
  // CHANGED: A-grade streak — feeds the counter card alongside the green streak.
  var aGradeStreakNow=calculateAGradeStreak(includeToday);
  var withdrawn=getTotalWithdrawn();
  var data=loadGamificationData();
  var seenIds=data.seenAchievements||[];
  var earned=getEarnedAchievements(rows,streak,withdrawn);
  var challenges=getWeekChallenges(rows);
  var [celebration,setCelebration]=useState(null);
  var [section,setSection]=useState("challenges");
  // CHANGED: Progress section defaults to collapsed; remember the user's choice across remounts.
  var [collapsed,setCollapsed]=useState(function(){try{var s=localStorage.getItem("tf-progress-collapsed");return s===null?true:s==="1";}catch(e){return true;}});
  useEffect(function(){try{localStorage.setItem("tf-progress-collapsed",collapsed?"1":"0");}catch(e){}},[collapsed]);
  useEffect(function(){
    syncChallengeCompletions(rows);
    var newOnes=checkNewAchievements(rows,streak,withdrawn);
    if(newOnes.length>0){setCelebration(newOnes[0]);setTimeout(function(){setCelebration(null);},4000);}
  },[]);
  // CHANGED: Rank/points removed from Progress. The card now shows only the clean-day streak,
  // Challenges, and Achievements. (Withdrawal allowance moved to Home's WithdrawalAllowanceCard.)
  var barStyle=function(){return {height:6,background:"#1e293b",borderRadius:3,overflow:"hidden",position:"relative",marginTop:4};};
  var barFill=function(pct,color){return {position:"absolute",top:0,left:0,bottom:0,width:Math.min(100,pct)+"%",background:color,borderRadius:3,transition:"width 0.5s"};};
  var tabs=["challenges","achievements"];
  // CHANGED: Embedded mode — render inside the combined Performance+Progress card (no own chrome,
  // always expanded, streak tiles omitted because the combined header shows them).
  var embedded=props.embedded;
  var eff=embedded?false:collapsed;
  return (
    <div style={embedded?{}:CS({marginBottom:16,padding:0,overflow:"hidden"})}>
      {celebration&&(
        <div style={{padding:"10px 14px",background:"#1e1b4b",borderBottom:"1px solid #4338ca",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:18}}>{celebration.icon}</span>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#a5b4fc"}}>Achievement unlocked: {celebration.name}</div>
            <div style={{fontSize:11,color:"#818cf8"}}>{achDesc(celebration)}</div>
          </div>
        </div>
      )}
      {!embedded&&<div style={{padding:"12px 14px 10px",borderBottom:collapsed?"none":"1px solid #1e293b"}}>
        <button onClick={function(){setCollapsed(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
          <div style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Progress</div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:11,color:"#94a3b8"}}>{earned.length} 🏆 · {getChallengeCompletions()} 🎯</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{transition:"transform 0.2s",transform:collapsed?"rotate(0deg)":"rotate(180deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
        </button>
      </div>}
      {/* CHANGED: Account Balance card was moved here from Performance — high-level scaling metric belongs with Progress. */}
      {!eff&&<div style={{padding:"12px 14px 0"}}>
        <ScalingTargetCard liveTotalPnL={props.todayPnL||0} settings={props.settings||{}}/>
      </div>}
      {/* CHANGED: Clean-day streak banner removed; green streak + A-grade streak now shown as compact counters. */}
      {!embedded&&!eff&&<div style={{padding:"12px 14px 0",display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
        <div style={{padding:"10px 12px",background:"#0a0a0f",border:"1px solid "+(streak>0?"#16653466":"#1e293b"),borderRadius:8}}>
          <div style={{fontSize:10,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>🌱 Green Streak</div>
          <div style={{fontSize:22,fontWeight:800,color:streak>0?"#22c55e":"#64748b",marginTop:2,fontVariantNumeric:"tabular-nums",lineHeight:1}}>{streak}<span style={{fontSize:11,color:"#94a3b8",fontWeight:500,marginLeft:4}}>day{streak===1?"":"s"}</span></div>
        </div>
        <div style={{padding:"10px 12px",background:"#0a0a0f",border:"1px solid "+(aGradeStreakNow>0?"#4338ca66":"#1e293b"),borderRadius:8}}>
          <div style={{fontSize:10,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>⭐ A-Grade Streak</div>
          <div style={{fontSize:22,fontWeight:800,color:aGradeStreakNow>0?"#a5b4fc":"#64748b",marginTop:2,fontVariantNumeric:"tabular-nums",lineHeight:1}}>{aGradeStreakNow}<span style={{fontSize:11,color:"#94a3b8",fontWeight:500,marginLeft:4}}>day{aGradeStreakNow===1?"":"s"}</span></div>
        </div>
      </div>}
      {!eff&&<div style={{display:"flex",borderBottom:"1px solid #1e293b",marginTop:12}}>
        {tabs.map(function(t){var active=section===t;return (
          <button key={t} onClick={function(){setSection(t);}} style={{flex:1,padding:"8px 2px",background:"none",border:"none",borderBottom:"2px solid "+(active?"#6366f1":"transparent"),color:active?"#e2e8f0":"#475569",fontSize:11,fontWeight:active?700:400,cursor:"pointer",fontFamily:"inherit",textTransform:"capitalize",transition:"color 0.15s"}}>{t}</button>
        );})}
      </div>}
      {!eff&&<div style={{padding:"12px 14px"}}>
        {section==="challenges"&&(function(){
          var ws=getWeekStart();
          var wsLabel=(ws.getMonth()+1)+"/"+ws.getDate();
          var done=challenges.filter(function(c){return c.done;}).length;
          return (
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontSize:12,color:"#64748b"}}>Week of {wsLabel}</div>
                <div style={{fontSize:12,fontWeight:600,color:done===challenges.length?"#22c55e":"#64748b"}}>{done} / {challenges.length} done</div>
              </div>
              {challenges.map(function(c){
                var pct=c.target>0?Math.round(c.current/c.target*100):0;
                var col=c.done?"#22c55e":"#6366f1";
                return (
                  <div key={c.id} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:14}}>{c.icon}</span>
                        <span style={{fontSize:12,color:c.done?"#e2e8f0":"#94a3b8"}}>{c.name}</span>
                      </div>
                      <span style={{fontSize:11,fontWeight:600,color:col}}>{c.done?"✓ Done":c.current+(c.suffix||"")+" / "+c.target+(c.suffix||"")}</span>
                    </div>
                    <div style={barStyle()}><div style={barFill(pct,col)}/></div>
                  </div>
                );
              })}
              <div style={{fontSize:10,color:"#334155",marginTop:8,textAlign:"center"}}>Resets every Sunday · completed challenges stay marked done</div>
            </div>
          );
        })()}
        {section==="achievements"&&(function(){
          var earnedIds=earned.map(function(a){return a.id;});
          var newIds=earnedIds.filter(function(id){return seenIds.indexOf(id)<0;});
          return (
            <div>
              <div style={{fontSize:11,color:"#64748b",marginBottom:10}}>{earned.length} / {ACHIEVEMENTS.length} unlocked</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {ACHIEVEMENTS.map(function(a){
                  var isEarned=earnedIds.indexOf(a.id)>=0;
                  var isNew=newIds.indexOf(a.id)>=0;
                  return (
                    <div key={a.id} style={{background:isEarned?"#0f1f2a":"#0a0a0f",border:"1px solid "+(isEarned?"#166534":"#1e293b"),borderRadius:6,padding:"8px 10px",opacity:isEarned?1:0.45}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                        <span style={{fontSize:16,filter:isEarned?"none":"grayscale(1)"}}>{a.icon}</span>
                        {isNew&&<span style={{fontSize:9,padding:"1px 5px",background:"#4338ca",borderRadius:3,color:"#a5b4fc",fontWeight:700}}>NEW</span>}
                      </div>
                      <div style={{fontSize:11,fontWeight:700,color:isEarned?"#e2e8f0":"#475569"}}>{a.name}</div>
                      <div style={{fontSize:10,color:isEarned?"#64748b":"#334155",marginTop:1,lineHeight:1.3}}>{achDesc(a)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>}
    </div>
  );
}
// CHANGED: Compact all-time performance summary for the Home tab. Mirrors PerformanceTab's exact
// formulas (win rate, profit factor, expectancy, P&L) over journal rows + today's live trades, so
// the headline numbers match the "All Time" view there. Tapping it jumps to the full Performance tab.
function PerformanceSummary(props){
  var rows=loadJournalRows();
  // Include today's live trades as a synthetic row if not already saved (matches PerformanceTab).
  var todayKey=todayStr();
  var hasTodayRow=rows.some(function(r){return r.date===todayKey;});
  var liveTrades=(props.todayTrades||[]).filter(function(t){return t&&t.status!=="open";});
  var allRows=rows.slice();
  if(!hasTodayRow&&liveTrades.length>0)allRows.push({date:todayKey,trades:liveTrades});
  var allTrades=[];allRows.forEach(function(r){(r.trades||[]).forEach(function(t){if(t.status!=="open")allTrades.push(t);});});
  if(allTrades.length===0)return null; // nothing to summarize yet
  var wins=allTrades.filter(function(t){return parseFloat(t.pnl)>0;});
  var losses=allTrades.filter(function(t){return parseFloat(t.pnl)<0;});
  var totalPnl=allTrades.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
  var winRate=Math.round((wins.length/allTrades.length)*100);
  var totalWins=wins.reduce(function(s,t){return s+parseFloat(t.pnl);},0);
  var totalLosses=Math.abs(losses.reduce(function(s,t){return s+parseFloat(t.pnl);},0));
  var pf=totalLosses>0?(totalWins/totalLosses).toFixed(2):totalWins>0?"∞":"0.00";
  var expValue=totalPnl/allTrades.length;
  var expPctArr=allTrades.map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});
  var expPctVal=expPctArr.length?expPctArr.reduce(function(s,v){return s+v;},0)/expPctArr.length:null;
  var tradingDays=allRows.filter(function(r){return (r.trades||[]).some(function(t){return t.status!=="open";});}).length;
  var pfNum=pf==="∞"?Infinity:parseFloat(pf);
  function Stat(p){return (
    <div style={{flex:"1 1 0",minWidth:0,padding:"8px 6px",textAlign:"center"}}>
      <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase",letterSpacing:0.5,fontWeight:600}}>{p.label}</div>
      <div style={{fontSize:16,fontWeight:700,color:p.color||"#e2e8f0",marginTop:3,fontVariantNumeric:"tabular-nums"}}>{p.value}</div>
    </div>
  );}
  return (
    <div style={CS({marginBottom:16,padding:0,overflow:"hidden"})}>
      <button onClick={function(){if(props.onNavigate)props.onNavigate();}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px 8px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <span style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Performance · All-time</span>
        <span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>View all →</span>
      </button>
      <div style={{display:"flex",borderTop:"1px solid #1e293b"}}>
        <Stat label="Win Rate" value={winRate+"%"} color={wrColor(winRate)}/>
        <Stat label="Expectancy" value={expPctVal!==null?(expPctVal.toFixed(2)+"%"):"—"} color={expPctVal!=null?(expPctVal>=0?"#22c55e":"#ef4444"):"#94a3b8"}/>
        <Stat label="Profit Factor" value={pf} color={pfNum>1?"#22c55e":pfNum<1?"#ef4444":"#94a3b8"}/>
      </div>
    </div>
  );
}

// CHANGED: Combined Performance + Progress card for Home — headline KPIs and streaks in one pretty
// band, with challenges/achievements/scaling embedded below.
// CHANGED: Today-first summary strip — the most decision-relevant numbers at a glance.
function TodayStrip(props){
  var settings=props.settings||{};
  var riskMax=parseFloat(settings.riskMax)||0;
  var todayTrades=(props.todayTrades||[]).filter(function(t){return t&&t.status!=="open";});
  var pnl=props.totalPnL||0;
  var rVal=riskMax>0?pnl/riskMax:0;
  // CHANGED: Single source of truth for today's discipline. If today is already saved to journal,
  // use the stored disciplineScore (kept in sync by the migration + commitment-edit handlers) so
  // the Today strip cannot disagree with the Journal / Performance displays.
  var storedTodayScore=null;
  try{
    var jk="journal:"+todayStr().replace(/\//g,"-");
    var js=typeof localStorage!=="undefined"?localStorage.getItem(jk):null;
    if(js){var je=JSON.parse(js);if(je&&je.disciplineScore!=null&&!isNaN(parseFloat(je.disciplineScore)))storedTodayScore=parseFloat(je.disciplineScore);}
  }catch(e){}
  var disc=storedTodayScore!=null
    ? storedTodayScore
    : calcDiscipline(todayTrades,riskMax,{commitment:(props.state&&props.state.commitment)||null});
  var cap=(props.state&&props.state.commitment&&props.state.commitment.maxTrades!=null&&props.state.commitment.maxTrades!=="")?parseInt(props.state.commitment.maxTrades):null;
  var pnlColor=pnl>0?"#22c55e":pnl<0?"#ef4444":"#94a3b8";
  // CHANGED: Intraday drawdown — sort today's closed trades chronologically, track peak cumulative P&L,
  // and record the largest dip below peak. Replaces the redundant Session tile (also shown in the header).
  var ddVal=0;
  (function(){
    var sorted=todayTrades.slice().sort(function(a,b){var ma=parseTimeToMinsOfDay(a.time)||0;var mb=parseTimeToMinsOfDay(b.time)||0;return ma-mb;});
    var c=0,p=0,worst=0;
    sorted.forEach(function(t){c+=parseFloat(t.pnl)||0;if(c>p)p=c;var dd=c-p;if(dd<worst)worst=dd;});
    ddVal=worst;
  })();
  var ddR=riskMax>0?ddVal/riskMax:0;
  var ddText=HIDE_DOLLAR_PNL
    ?(ddR<=-0.05?ddR.toFixed(1)+"R":"0R")
    :(ddVal<0?"-$"+Math.abs(ddVal).toFixed(0):"$0");
  var startBal=(props.currentAccount||0)-pnl;
  var pnlText=HIDE_DOLLAR_PNL
    ?((pnl>=0?"+":"")+(startBal>0?(pnl/startBal*100):0).toFixed(2)+"%")
    :((pnl<0?"-$":"$")+Math.abs(pnl).toFixed(2));
  var tiles=[
    {label:"Today P&L",value:pnlText,color:pnlColor},
    {label:"R Multiple",value:(rVal>=0?"+":"")+rVal.toFixed(1)+"R",color:rVal>=0?"#22c55e":"#ef4444"},
    {label:"Trades",value:cap!=null?(todayTrades.length+" / "+cap):String(todayTrades.length),color:cap!=null&&todayTrades.length>cap?"#ef4444":"#e2e8f0"},
    {label:"Intraday DD",value:ddText,color:ddVal<0?"#ef4444":"#94a3b8"},
    {label:"Discipline",value:Math.round(disc),color:discColor(disc)}
  ];
  return (
    <div style={CS({marginBottom:18,padding:0,overflow:"hidden"})}>
      <button onClick={function(){if(props.onNavigateToJournal)props.onNavigateToJournal();}} style={{width:"100%",padding:"11px 16px",background:"linear-gradient(135deg,#0f1a14 0%,#15151f 70%)",borderBottom:"1px solid #1e293b",border:"none",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <span style={{fontSize:13,color:"#86efac",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700}}>Today</span>
        <span style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:12,color:"#64748b"}}>{todayDisplay()}</span><span style={{fontSize:12,color:"#86efac",fontWeight:600}}>Journal →</span></span>
      </button>
      <div style={{display:"grid",gridTemplateColumns:props.mobile?"repeat(5,1fr)":"repeat(auto-fit,minmax(120px,1fr))",gap:1,background:"#1e293b"}}>
        {tiles.map(function(t){return (
          <div key={t.label} style={{padding:props.mobile?"9px 5px":"13px 14px",background:"#111118",display:"flex",flexDirection:"column",gap:props.mobile?3:5,minWidth:0}}>
            <span style={{fontSize:props.mobile?8:10,color:"#64748b",letterSpacing:props.mobile?0.2:0.6,textTransform:"uppercase",fontWeight:700,lineHeight:1.1,whiteSpace:props.mobile?"normal":"nowrap"}}>{t.label}</span>
            <span style={{fontSize:props.mobile?(t.small?11:15):(t.small?15:22),fontWeight:800,color:t.color,fontVariantNumeric:"tabular-nums",lineHeight:1.1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.value}</span>
          </div>
        );})}
      </div>
    </div>
  );
}

// CHANGED: Goals snapshot — mirrors the Goals tab's standard goals (same targets, values, and
// per-goal hidden map). Dollar values respect the global $/% toggle (masked, not dropped).
function GoalsSnapshot(props){
  var settings=props.settings||{};
  var riskMax=parseFloat(settings.riskMax)||0;
  var goals=(function(){try{var s=localStorage.getItem(GOALS_KEY);if(s){var p=JSON.parse(s);return (p&&typeof p==="object"&&!Array.isArray(p))?p:{};}}catch(e){}return {};})();
  var hidden=goals.hidden||{};
  var rows=loadJournalRows();
  var livePnL=props.totalPnL||0;
  var now=getNow();
  // CHANGED: Week is Sunday → Saturday to match the rest of the app.
  var y=now.getFullYear(),m=now.getMonth(),d=now.getDate(),day=now.getDay();
  var wkStart=new Date(y,m,d-day);
  var wkEnd=new Date(wkStart);wkEnd.setDate(wkStart.getDate()+6);
  var moStart=new Date(y,m,1);
  var todayKey=todayStr();
  // CHANGED: Only add livePnL when today's NOT already represented in saved journal rows
  // (avoids double-counting today after Save Day to Journal).
  var todayInRows=rows.some(function(e){return e.date===todayKey;});
  var weekPnL=rows.filter(function(e){var dd=new Date(e.date);return dd>=wkStart&&dd<=wkEnd;}).reduce(function(s,e){return s+(parseFloat(e.pnl)||0);},0)+(todayInRows?0:livePnL);
  var monthPnL=rows.filter(function(e){return new Date(e.date)>=moStart;}).reduce(function(s,e){return s+(parseFloat(e.pnl)||0);},0)+(todayInRows?0:livePnL);
  // CHANGED: When today's already saved to journal, prefer the journal entry's pnl over livePnL
  // (livePnL can be 0 after rollover/sync while the journal still has the day's saved total).
  var todayRow=rows.find(function(e){return e.date===todayKey;});
  var dailyPnL=todayRow?(parseFloat(todayRow.pnl)||0):livePnL;
  var allT=rows.reduce(function(a,e){return a.concat(e.trades||[]);},[]);
  var allW=allT.filter(function(t){return parseFloat(t.pnl)>0;});
  var oWR=allT.length>0?allW.length/allT.length*100:0;
  var aDisc=rows.length>0?rows.reduce(function(s,e){return s+calcDiscipline(e.trades||[],e.riskMax,{commitment:e.commitment||null});},0)/rows.length:0;
  var autoDaily=computeDailyTarget(settings);
  var weeklyMultiplier=parseFloat(goals.weeklyMultiplier)||4;
  var dailyTarget=autoDaily,weeklyTarget=autoDaily*weeklyMultiplier;
  var monthlyTarget=parseFloat(goals.monthlyPnL)||0;
  var winRateTarget=parseFloat(goals.winRate)||0;
  var disciplineTarget=loadDisciplineLockThreshold();
  var accountTarget=parseFloat(goals.accountTarget)||0;
  var withdrawalTarget=parseFloat(goals.withdrawals)||0;
  var totalWithdrawn=getTotalWithdrawn();
  function money(v){if(HIDE_DOLLAR_PNL)return (v<0?"-":"")+"$•••";return (v<0?"-$":"$")+Math.abs(Math.round(v)).toLocaleString();}
  // CHANGED: when $ is hidden, P&L goals are shown in R (value ÷ risk-per-trade).
  function rFmt(v){var r=riskMax>0?v/riskMax:0;return (r>=0?"+":"")+r.toFixed(1)+"R";}
  var pnlVal=HIDE_DOLLAR_PNL?rFmt:money;
  var pnlTgt=HIDE_DOLLAR_PNL?rFmt:money;
  // CHANGED: build GoalRing tiles grouped by category to mirror the Goals tab.
  var account=[],perf=[],pnl=[];
  if(!hidden.account&&accountTarget>0)account.push({key:"account",label:"Account Balance",value:props.currentAccount||0,target:accountTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true,formatValue:money,formatTarget:money,compact:true});
  if(!hidden.withdrawals&&withdrawalTarget>0)account.push({key:"withdrawals",label:"Total Withdrawn",value:totalWithdrawn,target:withdrawalTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true,formatValue:money,formatTarget:money,compact:true});
  if(!hidden.winRate&&winRateTarget>0)perf.push({key:"winRate",label:"Win Rate",value:oWR,target:winRateTarget,suffix:"%",decimals:0,targetDecimals:0,wrColor:true,compact:true});
  if(!hidden.discipline&&disciplineTarget>0)perf.push({key:"discipline",label:"Discipline",value:aDisc,target:disciplineTarget,suffix:"%",decimals:0,targetDecimals:0,discColor:true,compact:true});
  if(!hidden.daily&&dailyTarget>0)pnl.push({key:"daily",label:"Today's P&L",value:dailyPnL,target:dailyTarget,prefix:"$",decimals:0,targetDecimals:0,formatValue:pnlVal,formatTarget:pnlTgt,compact:true});
  if(!hidden.weekly&&weeklyTarget>0)pnl.push({key:"weekly",label:"Week P&L",value:weekPnL,target:weeklyTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true,formatValue:pnlVal,formatTarget:pnlTgt,compact:true});
  if(!hidden.monthly&&monthlyTarget>0)pnl.push({key:"monthly",label:"Month P&L",value:monthPnL,target:monthlyTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true,formatValue:pnlVal,formatTarget:pnlTgt,compact:true});
  // CHANGED: Inject custom goals into the appropriate default section so they show on Home alongside built-ins.
  var customList=Array.isArray(goals.custom)?goals.custom:[];
  function homeCustomVal(g){
    if(g.metric==="custom")return parseFloat(g.customValue||0)||0;
    if(g.metric==="pnl"){if(g.period==="daily")return dailyPnL;if(g.period==="weekly")return weekPnL;if(g.period==="monthly")return monthPnL;return totalAllPnL||0;}
    if(g.metric==="winrate")return parseFloat((oWR||0).toFixed(1));
    if(g.metric==="discipline")return parseFloat((aDisc||0).toFixed(0));
    if(g.metric==="balance")return props.currentAccount||0;
    if(g.metric==="trades")return (props.state&&props.state.trades?props.state.trades.length:0);
    return 0;
  }
  customList.forEach(function(cg){
    var v=homeCustomVal(cg),t=parseFloat(cg.target)||0;
    var card={key:"custom-"+cg.id,label:cg.title,value:v,target:t,prefix:cg.prefix||"",suffix:cg.suffix||"",decimals:cg.metric==="winrate"||cg.metric==="discipline"||cg.metric==="trades"?0:0,targetDecimals:0,wrColor:cg.metric==="winrate",discColor:cg.metric==="discipline",compact:true};
    if(cg.section==="account")account.push(card);
    else if(cg.section==="performance")perf.push(card);
    else if(cg.section==="pnl")pnl.push(card);
    // "custom" default + "namedCustom" remain in the dedicated +N count below.
  });
  var total=account.length+perf.length+pnl.length;
  var customCount=customList.filter(function(cg){return cg.section!=="account"&&cg.section!=="performance"&&cg.section!=="pnl";}).length;
  var gridStyle={display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(104px,1fr))",gap:8,alignItems:"stretch"};
  function Section(p){
    if(p.items.length===0)return null;
    return (
      <div style={{marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:6,margin:"0 0 8px"}}><span style={{fontSize:12}}>{p.icon}</span><span style={{fontSize:10,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>{p.title}</span><div style={{flex:1,height:1,background:"#1e293b"}}/></div>
        <div style={gridStyle}>{p.items.map(function(it){return <GoalRing key={it.key} {...it}/>;})}</div>
      </div>
    );
  }
  return (
    <div style={CS({marginBottom:16,padding:0,overflow:"hidden"})}>
      <button onClick={function(){if(props.onNavigate)props.onNavigate();}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",background:"none",border:"none",borderBottom:total?"1px solid #1e293b":"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <span style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Goals</span>
        <span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>View all →</span>
      </button>
      {total===0?(
        <div style={{padding:"16px 14px",fontSize:13,color:"#64748b",lineHeight:1.5}}>No goals set yet.{customCount>0?" "+customCount+" custom goal"+(customCount===1?"":"s")+" — open Goals to track.":" Set targets in the Goals tab."}</div>
      ):(
        <div style={{padding:"14px"}}>
          <Section icon="🏦" title="Account Activity" items={account}/>
          <Section icon="🎯" title="Performance" items={perf}/>
          <Section icon="💰" title="P&L" items={pnl}/>
          {customCount>0&&<div style={{fontSize:11,color:"#64748b"}}>+{customCount} custom goal{customCount===1?"":"s"} in Goals →</div>}
        </div>
      )}
    </div>
  );
}

function PerfProgressCard(props){
  var rows=loadJournalRows();
  var todayKey=todayStr();
  var hasTodayRow=rows.some(function(r){return r.date===todayKey;});
  var liveTrades=(props.todayTrades||[]).filter(function(t){return t&&t.status!=="open";});
  var allRows=rows.slice();
  if(!hasTodayRow&&liveTrades.length>0)allRows.push({date:todayKey,trades:liveTrades});
  var allTrades=[];allRows.forEach(function(r){(r.trades||[]).forEach(function(t){if(t.status!=="open")allTrades.push(t);});});
  var hasData=allTrades.length>0;
  var wins=allTrades.filter(function(t){return parseFloat(t.pnl)>0;});
  var losses=allTrades.filter(function(t){return parseFloat(t.pnl)<0;});
  var winRate=hasData?Math.round((wins.length/allTrades.length)*100):null;
  var totalWins=wins.reduce(function(s,t){return s+parseFloat(t.pnl);},0);
  var totalLosses=Math.abs(losses.reduce(function(s,t){return s+parseFloat(t.pnl);},0));
  var pf=totalLosses>0?(totalWins/totalLosses).toFixed(2):totalWins>0?"∞":"0.00";
  var pfNum=pf==="∞"?Infinity:parseFloat(pf);
  var expPctArr=allTrades.map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});
  var expPctVal=expPctArr.length?expPctArr.reduce(function(s,v){return s+v;},0)/expPctArr.length:null;
  var streak=calculateStreak(true);
  var aGrade=calculateAGradeStreak(true);
  // CHANGED: Days-since-discipline-lock — walks trading days (those with closed trades OR
  // explicit no-trade entries) in reverse chrono and counts until the first wasLocked day.
  // Mirrors the no-lock-streak achievement helper; replaces the A-Grade Streak tile on Home.
  var daysSinceLock=(function(){
    try{
      var tradingDays=loadJournalRows().filter(function(d){return (d.trades||[]).length>0||d.noTradeDay;}).sort(function(a,b){return new Date(b.date)-new Date(a.date);});
      var n=0;for(var i=0;i<tradingDays.length;i++){if(tradingDays[i].wasLocked)break;n++;}return n;
    }catch(e){return 0;}
  })();
  var kpis=[
    {label:"Win Rate",icon:"🎯",value:hasData?winRate+"%":"—",color:hasData?wrColor(winRate):"#64748b"},
    {label:"Profit Factor",icon:"⚖️",value:hasData?pf:"—",color:hasData?(pfNum>1?"#22c55e":pfNum<1?"#ef4444":"#94a3b8"):"#64748b"},
    {label:"Expectancy",icon:"📈",value:expPctVal!=null?((expPctVal>=0?"+":"")+expPctVal.toFixed(2)+"%"):"—",color:expPctVal!=null?(expPctVal>=0?"#22c55e":"#ef4444"):"#64748b"},
    {label:"Green Streak",icon:"🌱",value:streak,suffix:streak===1?" day":" days",color:streak>0?"#22c55e":"#64748b"},
    {label:"Days Since Lock",icon:"🛡",value:daysSinceLock,suffix:daysSinceLock===1?" day":" days",color:daysSinceLock>=10?"#22c55e":daysSinceLock>0?"#a5b4fc":"#64748b"}
  ];
  // CHANGED: compact summary shown in the collapsed header.
  var [open,setOpen]=useState(false);
  return (
    <div style={CS({marginBottom:18,padding:0,overflow:"hidden"})}>
      <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 16px",background:"linear-gradient(135deg,#1e1b4b 0%,#15151f 70%)",border:"none",borderBottom:"1px solid #312e81",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <span style={{fontSize:13,color:"#c7d2fe",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700}}>Performance &amp; Progress</span>
        <svg width="13" height="13" viewBox="0 0 12 12" fill="none" style={{transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#a5b4fc" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {/* CHANGED: On mobile, KPI tiles wrap to a 2-column grid so labels aren't truncated and
         each value has room to breathe. Desktop unchanged. */}
      <div style={{display:"grid",gridTemplateColumns:props.mobile?"repeat(2,1fr)":"repeat(auto-fit,minmax(132px,1fr))",gap:1,background:"#1e293b"}}>
        {kpis.map(function(k){return (
          <div key={k.label} style={{padding:props.mobile?"11px 12px":"14px 14px 13px",background:"#111118",display:"flex",flexDirection:"column",gap:props.mobile?5:6,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:props.mobile?6:6,minWidth:0}}>
              <span style={{fontSize:props.mobile?12:13,flexShrink:0}}>{k.icon}</span>
              <span style={{fontSize:props.mobile?10:10,color:"#64748b",letterSpacing:0.6,textTransform:"uppercase",fontWeight:700,lineHeight:1.1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{k.label}</span>
            </div>
            <div style={{fontSize:props.mobile?20:24,fontWeight:800,color:k.color,fontVariantNumeric:"tabular-nums",lineHeight:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{k.value}{k.suffix&&<span style={{fontSize:props.mobile?10:12,color:"#64748b",fontWeight:500}}>{k.suffix}</span>}</div>
          </div>
        );})}
      </div>
      {open&&<>
      <div style={{padding:"12px 14px 4px"}}>
        <ScalingTargetCard liveTotalPnL={props.todayPnL||0} settings={props.settings||{}}/>
      </div>
      <button onClick={function(){if(props.onNavigate)props.onNavigate();}} style={{width:"100%",padding:"10px",background:"none",border:"none",borderTop:"1px solid #1e293b",color:"#a5b4fc",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>View full performance →</button>
      </>}
    </div>
  );
}

// CHANGED: Withdrawal allowance was removed from Home; the suggested allowance now lives only in the
// Settings transfer section. Withdrawals remain growth-gated (% of profit since last withdrawal).
function DashboardTab(props){
  var settings=props.settings,phase=props.phase,onStartTrade=props.onStartTrade,preCheckComplete=props.preCheckComplete,currentAccount=props.currentAccount;
  var displayPosMin=props.displayPosMin,displayPosMax=props.displayPosMax,displayRiskMin=props.displayRiskMin,displayRiskMax=props.displayRiskMax;
  var totalPnL=props.totalPnL,prevPnL=props.prevPnL,prevDate=props.prevDate,prevRiskMax=props.prevRiskMax,onNavigateToTrade=props.onNavigateToTrade;
  // CHANGED: Re-evaluate the checklist visibility window every 30s so it appears/hides at the right time
  // even while the phase is still "closed" (e.g. the 15-min pre-session lead-in).
  var [, setTick]=useState(0);
  useEffect(function(){var id=setInterval(function(){setTick(function(t){return t+1;});},30000);return function(){clearInterval(id);};},[]);
  var checklistVisible=isChecklistWindowOpen(settings);
  var hasLiveTrades=totalPnL!==0;
  var hasHistory=prevPnL!==null;
  var displayPnL=hasLiveTrades?totalPnL:(hasHistory?parseFloat(prevPnL):null);
  var redDay=displayPnL!==null&&displayPnL<0,greenDay=displayPnL!==null&&displayPnL>=0;
  var focusRiskMax=hasLiveTrades?(parseFloat(settings.riskMax)||0):(prevRiskMax>0?prevRiskMax:(parseFloat(settings.riskMax)||0));
  var rValue=displayPnL!==null&&focusRiskMax>0?(Math.abs(displayPnL)/focusRiskMax).toFixed(1)+"R":"0R";
  var focusTimeLabel=hasLiveTrades?"today":(hasHistory?(prevDate===todayStr()?"today":"yesterday"):"no history");
  var focusStateKey=displayPnL===null?"neutral":(redDay?"red":"green");
  var focusCfg=getFocusStates(settings)[focusStateKey]||{};
  var focusEnabled=focusCfg.enabled!==false;
  var focusItems=(Array.isArray(focusCfg.items)?focusCfg.items:[]).filter(function(x){return x&&x.trim();});
  var focusTitle=(focusCfg.title&&focusCfg.title.trim())?focusCfg.title:"Today's Focus";
  var showFocus=focusEnabled&&focusItems.length>0;
  // CHANGED: Laptop layout — full-width attention items on top (checklist, allowance notice),
  // then a two-column grid: calendar + log button on the left, daily widgets on the right.
  return (
    <div style={{paddingTop:16}}>
      {/* CHANGED: Pre-Market Checklist shown only from 15 min before the first enabled session until the last session ends. The complete button now lives inside the panel. */}
      {checklistVisible&&props.state&&props.setState&&(
        <ChecklistPanel state={props.state} setState={props.setState} settings={settings} preCheckComplete={preCheckComplete} checklistVersion={props.checklistVersion} onNavigateToJournal={props.onNavigateToJournal}/>
      )}
      {/* CHANGED: Half-size next-trade nudge. If yesterday closed at or above the R threshold and
         we haven't dismissed for today, surface a one-time suggestion to half-size the first
         trade. Disappears once today has any closed trade (the moment has passed). */}
      {(function(){
        var last=getLastDayR();
        if(!last||!last.date)return null;
        var t=todayStr();
        if(last.date===t)return null; // need yesterday, not today
        var threshold=getHalfSizeRThreshold();
        if(last.r<threshold)return null;
        if(halfSizeNudgeDismissedFor(t))return null;
        var hasTodayClosed=(props.state.trades||[]).some(function(x){return x.status!=="open";});
        if(hasTodayClosed)return null;
        return (
          <div style={{marginBottom:12,padding:"12px 16px",background:"linear-gradient(135deg,#451a03,#78350f)",border:"1px solid #f59e0b",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:13,fontWeight:800,color:"#fff",display:"flex",alignItems:"center",gap:7}}>🛑 Yesterday closed +{last.r.toFixed(1)}R — consider half-size on the first trade</div>
              <div style={{fontSize:11,color:"#fde68a",marginTop:3,lineHeight:1.5}}>One-trade speed bump to interrupt post-win overconfidence. You can ignore this — it's a nudge, not a rule.</div>
            </div>
            <button onClick={function(){dismissHalfSizeNudge(t);if(props.bumpReloadKey)props.bumpReloadKey();}} style={{padding:"6px 12px",background:"#0a0a0f44",border:"1px solid #92400e",borderRadius:6,color:"#fde68a",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0}}>Got it</button>
          </div>
        );
      })()}
      {/* CHANGED: Profit-take nudge after a green streak. Encourages WITHDRAWING (not scaling
         down) so the trader pays themselves before greed compounds positions. Dismissal stores
         the streak length at the time so the banner only returns if the streak grows further. */}
      {(function(){
        var streak=calculateStreak(true);
        var threshold=getStreakNudgeThreshold();
        if(streak<threshold)return null;
        if(streakNudgeDismissedAt()>=streak)return null;
        var allowance=getWithdrawalAllowance(totalPnL);
        var fmt=function(n){return "$"+Math.round(n).toLocaleString();};
        return (
          <div style={{marginBottom:12,padding:"12px 16px",background:"linear-gradient(135deg,#064e3b,#065f46)",border:"1px solid #10b981",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:13,fontWeight:800,color:"#fff",display:"flex",alignItems:"center",gap:7}}>💰 {streak}-day green streak — pay yourself</div>
              <div style={{fontSize:11,color:"#a7f3d0",marginTop:3,lineHeight:1.5}}>Lock in some of these gains before greed cranks up size. Suggested withdrawal: {fmt(allowance)}.</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6,flexShrink:0}}>
              {props.onWithdraw&&allowance>0&&<button onClick={function(){props.onWithdraw(Math.round(allowance));}} style={{padding:"6px 12px",background:"#022c22",border:"1px solid #10b981",borderRadius:6,color:"#a7f3d0",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>Withdraw →</button>}
              <button onClick={function(){dismissStreakNudge(streak);if(props.bumpReloadKey)props.bumpReloadKey();}} style={{padding:"6px 12px",background:"#0a0a0f44",border:"1px solid #065f46",borderRadius:6,color:"#a7f3d0",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>Dismiss</button>
            </div>
          </div>
        );
      })()}
      {/* CHANGED: Allowance-target reached notification. Shows when the user set a target, the live
          allowance has reached it, and it hasn't been dismissed. Dismiss marks it acknowledged. */}
      {(function(){
        var target=getAllowanceTarget();
        if(target<=0)return null;
        var allowance=getWithdrawalAllowance(totalPnL);
        if(allowance<target)return null;
        if(getAllowanceNotifDismissed())return null;
        var fmt=function(n){return "$"+Math.round(n).toLocaleString();};
        return (
          <div style={{marginBottom:16,padding:"14px 16px",background:"linear-gradient(135deg,#14532d,#166534)",border:"1px solid #22c55e",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:14,fontWeight:800,color:"#fff",display:"flex",alignItems:"center",gap:7}}>🔔 Withdrawal allowance reached {fmt(target)}</div>
              <div style={{fontSize:12,color:"#bbf7d0",marginTop:3,lineHeight:1.5}}>Your allowance is now {fmt(allowance)}{HIDE_DOLLAR_PNL?"":""}. {props.onWithdraw?"Tap to log a withdrawal, or":"You can"} dismiss this.</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6,flexShrink:0}}>
              {props.onWithdraw&&<button onClick={function(){props.onWithdraw(Math.round(target));}} style={{padding:"6px 12px",background:"#052e16",border:"1px solid #22c55e",borderRadius:6,color:"#86efac",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>Withdraw →</button>}
              <button onClick={function(){setAllowanceNotifDismissed(true);if(props.bumpReloadKey)props.bumpReloadKey();}} style={{padding:"6px 12px",background:"#0a0a0f44",border:"1px solid #166534",borderRadius:6,color:"#bbf7d0",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>Dismiss</button>
            </div>
          </div>
        );
      })()}
      {/* CHANGED: Today-first dashboard — Today strip, then all-time Performance & Progress,
          then a responsive row of week calendar + goals snapshot + economic events. */}
      <TodayStrip mobile={props.mobile} settings={settings} phase={props.phase} state={props.state} totalPnL={totalPnL} todayTrades={props.todayTrades} currentAccount={currentAccount} onNavigateToJournal={props.onNavigateToJournal}/>
      <PerfProgressCard mobile={props.mobile} todayPnL={totalPnL} todayTrades={props.todayTrades} settings={settings} onWithdraw={props.onWithdraw} onNavigate={props.onNavigateToPerformance}/>
      <div style={{display:"grid",gridTemplateColumns:props.mobile?"1fr":"repeat(auto-fit,minmax(320px,1fr))",gap:18,alignItems:"start"}}>
        <div style={{minWidth:0}}>
          <DashboardCalendar defaultOpen={false} totalPnL={totalPnL} onSelectDate={onNavigateToTrade} currentAccount={currentAccount} riskMax={parseFloat(settings.riskMax)||0} settings={settings} todayTrades={props.todayTrades}/>
          <EconomicEvents reloadKey={props.eventsReloadKey} onNavigateToSettings={props.onNavigateToSettings} currencyFilter={props.eventCurrencyFilter} setCurrencyFilter={props.setEventCurrencyFilter} impactFilter={props.eventImpactFilter} setImpactFilter={props.setEventImpactFilter}/>
        </div>
        <div style={{minWidth:0}}>
          <GoalsSnapshot settings={settings} todayTrades={props.todayTrades} totalPnL={totalPnL} currentAccount={currentAccount} onNavigate={props.onNavigateToGoals}/>
        </div>
      </div>
    </div>
  );
}

// CHANGED: PRE-MARKET COMMITMENT PANEL — set a plan before trading; locks once committed so it
// can't be quietly edited mid-day. Shows in the pre-market/active phase before the day's review.
function CommitmentPanel(props){
  var state=props.state,setState=props.setState,phase=props.phase,settings=props.settings;
  var c=state.commitment||{};
  var committed=!!c.committed;
  var [open,setOpen]=useState(!committed);
  // CHANGED: Default Max Trades to the SUM of enabled sessions' maxTrades for today's weekday,
  // pulled from Session Strategy. The user can override; helper text shows the breakdown.
  var sessionCapBreakdown=(function(){
    try{
      var dow=getNow().getDay();
      var sess=getSessions(settings||{}).filter(function(s){if(s.enabled===false)return false;var days=s.days||[1,2,3,4,5];return days.indexOf(dow)>=0;});
      var parts=sess.map(function(s){return {label:s.label||s.id,cap:(s.maxTrades!=null?parseInt(s.maxTrades):99)};}).filter(function(x){return !isNaN(x.cap);});
      var total=parts.reduce(function(s,x){return s+x.cap;},0);
      return {parts:parts,total:total};
    }catch(e){return {parts:[],total:0};}
  })();
  // CHANGED: max-trades is now derived from session strategy, not user-entered.
  var derivedMax=sessionCapBreakdown.total>0?String(sessionCapBreakdown.total):"";
  var [setups,setSetups]=useState(c.setups||"");
  function commit(){
    setState(function(s){return Object.assign({},s,{commitment:{committed:true,committedAt:Date.now(),maxTrades:derivedMax,setups:setups,reviewed:false,setupsReviewAffirmed:null}});});
    setOpen(false);
  }
  var lbl={fontSize:12,color:"#94a3b8",fontWeight:600,marginBottom:4,display:"block"};
  var fld={width:"100%",padding:"10px 12px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:8,color:"#e2e8f0",fontSize:14,fontFamily:"inherit",boxSizing:"border-box"};
  if(committed&&!open){
    return (
      <div style={{marginBottom:props.hideMargin?0:14,padding:"12px 14px",background:"#0f1a14",border:"1px solid #166534",borderRadius:10,width:"100%",boxSizing:"border-box",display:"flex",flexDirection:"column"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:13,fontWeight:700,color:"#86efac"}}>✓ Today's commitment</span>
          <span style={{fontSize:11,color:"#94a3b8"}}>locked in</span>
        </div>
        <div style={{fontSize:13,color:"#cbd5e1",marginTop:6,lineHeight:1.5}}>
          {c.maxTrades?("Max "+c.maxTrades+" trade"+(parseInt(c.maxTrades)===1?"":"s")):"No trade cap set"}{c.setups?(" · "+c.setups):""}
        </div>
        <div style={{fontSize:11,color:"#64748b",marginTop:6}}>You'll be scored against this at day's end.</div>
      </div>
    );
  }
  return (
    <div style={{marginBottom:14,padding:"14px",background:"#111118",border:"1px solid #4338ca",borderRadius:10}}>
      <div style={{fontSize:14,fontWeight:700,color:"#a5b4fc",marginBottom:4}}>Commit to today's plan</div>
      <div style={{fontSize:12,color:"#64748b",marginBottom:12,lineHeight:1.5}}>State it before you trade. At day's end you're scored against your own plan — not a generic rule.</div>
      <div style={{marginBottom:10}}>
        <label style={lbl}>Max trades today</label>
        <div style={{padding:"10px 12px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:8,fontSize:14,color:"#e2e8f0",fontFamily:"inherit"}}>{derivedMax?(derivedMax+" trade"+(parseInt(derivedMax)===1?"":"s")):"No cap from session strategy"}</div>
        {sessionCapBreakdown.parts.length>0&&(
          <div style={{fontSize:11,color:"#64748b",marginTop:5,lineHeight:1.5}}>
            From session strategy: {sessionCapBreakdown.parts.map(function(p,i){return p.label+" "+p.cap+(i<sessionCapBreakdown.parts.length-1?" + ":"");}).join("")}. Edit in Settings → Session Strategy.
          </div>
        )}
      </div>
      <div style={{marginBottom:12}}>
        <label style={lbl}>Setups you'll take (and what you'll skip)</label>
        <textarea value={setups} onChange={function(e){setSetups(e.target.value);}} placeholder="e.g. Only A+ breakouts at PDH/PDL. Skip chop in the mid-day lull." style={Object.assign({},fld,{minHeight:64,resize:"vertical",lineHeight:1.5})}/>
      </div>
      <button onClick={commit} style={{width:"100%",padding:"12px",background:"linear-gradient(135deg,#4f46e5,#6366f1)",color:"#fff",border:"none",borderRadius:8,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{committed?"Update commitment":"Commit to plan"}</button>
      {committed&&<button onClick={function(){setOpen(false);}} style={{width:"100%",padding:"8px",marginTop:6,background:"none",color:"#64748b",border:"none",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>}
    </div>
  );
}

// CHANGED: Compact Conditions chip — always collapsed. Click toggles between Clear and Choppy
// by marking all condition items checked/unchecked at once.
function CompactConditions(props){
  var allGood=props.allGood,condItems=props.condItems,warnings=props.warnings,conditionsChecked=props.conditionsChecked,setState=props.setState;
  function toggle(){
    setState(function(s){
      var c={};
      if(allGood){condItems.forEach(function(it){c[it.key]=true;});}
      return Object.assign({},s,{conditionsChecked:c});
    });
  }
  return (
    <button onClick={toggle} style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"6px 10px",background:allGood?"#0a1f1066":"#1c0a0a66",border:"1px solid "+(allGood?"#16653466":"#7f1d1d66"),borderRadius:6,cursor:"pointer",fontFamily:"inherit",width:"100%"}}>
      <span style={{width:6,height:6,borderRadius:"50%",background:allGood?"#22c55e":"#ef4444"}}/>
      <span style={{fontSize:11,color:allGood?"#86efac":"#fca5a5",fontWeight:600,letterSpacing:0.5}}>{allGood?"Conditions clear":"Conditions choppy"}</span>
      <span style={{fontSize:10,color:"#64748b",marginLeft:"auto"}}>{allGood?"tap to flag":"tap to clear"}</span>
    </button>
  );
}

// CHANGED: TradesTab now hides position/risk readouts until pre-market checklist is complete.
// CHANGED: Position/risk readout displays slippage % alongside max instead of "$min-$max".
// CHANGED: Warns in the Journal when an economic event matching the user's filters is imminent.
function EventWarningBanner(props){
  var [now,setNow]=useState(getPT());
  useEffect(function(){var id=setInterval(function(){setNow(getPT());},30000);return function(){clearInterval(id);};},[]);
  var [dismissed,setDismissed]=useState({});
  var windowMin=props.windowMin||60;
  var events=getImminentEvents(windowMin).filter(function(e){return !dismissed[(e.title||e.event||"")+"|"+e.date+"|"+(e.time||"")];});
  if(events.length===0)return null;
  function mins(d){return Math.max(0,Math.round((d-now)/60000));}
  function impColor(imp){var n=normalizeImpact(imp);return n==="high"?"#ef4444":n==="medium"?"#f59e0b":"#22c55e";}
  return (
    <div style={Object.assign(CS({marginBottom:14}),{border:"1px solid #7f1d1d",background:"#1a0e0e"})}>
      <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
        <div style={{fontSize:20,lineHeight:1.1,flexShrink:0}}>⚠️</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:800,color:"#fca5a5",letterSpacing:0.3,marginBottom:6}}>{events.length===1?"High-impact event approaching":events.length+" events approaching"}</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {events.slice(0,4).map(function(e,i){
              var m=mins(e._d);
              var key=(e.title||e.event||"")+"|"+e.date+"|"+(e.time||"");
              return (
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#e2e8f0"}}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:impColor(e.impact),flexShrink:0}}/>
                  <span style={{fontWeight:700,color:"#cbd5e1",flexShrink:0}}>{eventCurrency(e)}</span>
                  <span style={{flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.title||e.event||"Event"}</span>
                  <span style={{flexShrink:0,fontWeight:700,color:m<=15?"#fca5a5":"#fbbf24",fontVariantNumeric:"tabular-nums"}}>{m===0?"now":"in "+m+"m"}</span>
                  <button onClick={function(){setDismissed(function(d){var n=Object.assign({},d);n[key]=true;return n;});}} aria-label="Dismiss" style={{flexShrink:0,width:18,height:18,padding:0,background:"none",border:"none",color:"#64748b",fontSize:14,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>
                </div>
              );
            })}
          </div>
          <div style={{fontSize:11,color:"#94a3b8",marginTop:8,lineHeight:1.4}}>Consider sizing down or standing aside around the release. Volatility can spike and spreads can widen.</div>
        </div>
      </div>
    </div>
  );
}

function TradesTab(props){
  var state=props.state,showForm=props.showForm,setShowForm=props.setShowForm,trade=props.trade,setTrade=props.setTrade,saveTrade=props.saveTrade,deleteTrade=props.deleteTrade,tradeStatus=props.tradeStatus,phase=props.phase,settings=props.settings,preCheckComplete=props.preCheckComplete,totalPnL=props.totalPnL;
  var [editingId,setEditingId]=useState(null);
  var [editDraft,setEditDraft]=useState(null);
  var [pastNewTrade,setPastNewTrade]=useState(null);
  function startEdit(t){setEditingId(t.id);setEditDraft(Object.assign({},t));}
  function cancelEdit(){setEditingId(null);setEditDraft(null);}
  var [pickerOpen,setPickerOpen]=useState(false);
  var [selectedDate,setSelectedDate]=useState(props.initialDate||todayStr());
  var [pastSessions,setPastSessions]=useState([]);
  // CHANGED: Track today's saved journal entry so we can render its summary after save.
  var [todayJournalEntry,setTodayJournalEntry]=useState(null);
  useEffect(function(){
    try{
      var k="journal:"+todayStr().replace(/\//g,"-");
      var s=localStorage.getItem(k);
      // CHANGED: if storage read returns null, do NOT overwrite an entry we just saved in memory.
      // Previously this clobbered todayJournalEntry to null right after save, making the Save panel reappear.
      if(!s)return;
      var entry=JSON.parse(s);
      // CHANGED: Back-fill noTradeLoggedAt on legacy no-trade entries that were saved before the
      // timestamp field existed, so the "Why no trades" banner can always show when it was logged.
      if(entry&&entry.noTradeDay&&!entry.noTradeLoggedAt){
        entry.noTradeLoggedAt=Date.now();
        try{localStorage.setItem(k,JSON.stringify(entry));}catch(e){}
      }
      setTodayJournalEntry(entry);
    }catch(e){}
  },[props.reloadKey]);
  // CHANGED: Multi-level sort. sortChain is an ordered list of sort ids (priority: primary first).
  // Empty chain = default timestamp sort. Each id breaks ties of the ones before it.
  var [sortChain,setSortChain]=useState([]);
  var [sortOpen,setSortOpen]=useState(false);
  var [filterOpen,setFilterOpen]=useState(false);
  var [filters,setFilters]=useState({});
  // CHANGED: Screenshot gallery scope — "session" (current date) or "all" (whole journal).
  var [galleryScope,setGalleryScope]=useState("session");
  // CHANGED: No-Trade Day screenshot upload state + a lightbox viewer for those shots.
  var noTradeShotRef=useRef(null);
  var [uploadingNoTradeShot,setUploadingNoTradeShot]=useState(false);
  var [noTradeShotError,setNoTradeShotError]=useState(null);
  var [noTradeViewer,setNoTradeViewer]=useState(null);
  useEffect(function(){var rows=loadJournalRows().filter(function(e){return e.date!==todayStr();});rows.sort(function(a,b){return new Date(b.date)-new Date(a.date);});setPastSessions(rows);},[props.reloadKey,props.timezone,selectedDate]);
  useEffect(function(){if(props.initialDate)setSelectedDate(props.initialDate);},[props.initialDate]);
  var isToday=selectedDate===todayStr();
  var pastSession=!isToday?pastSessions.find(function(s){return s.date===selectedDate;}):null;
  var rawTrades=isToday?state.trades:(pastSession?pastSession.trades:[]);
  function saveNewPastTrade(t){
    if(!pastSession&&selectedDate===todayStr())return;
    var fn=props.autoAddViolations||function(x){return x;};
    var enriched=fn(Object.assign({},t,{closedAt:t.closedAt||Date.now(),status:"closed"}),settings.positionMax);
    var existing=pastSession||{date:selectedDate,pnl:0,trades:[],wins:0,losses:0,disciplineScore:100,riskMax:parseFloat(settings.riskMax)||0};
    var ut=(existing.trades||[]).concat([enriched]);
    // CHANGED: A past day's riskMax is a historical fact — preserve the entry's own riskMax (only
    // fall back to current settings if absent), and score discipline against that same value.
    var entryRiskMax=(existing.riskMax!=null&&parseFloat(existing.riskMax)>0)?parseFloat(existing.riskMax):(parseFloat(settings.riskMax)||0);
    var newEntry=Object.assign({},existing,{trades:ut,wins:ut.filter(function(x){return parseFloat(x.pnl)>0;}).length,losses:ut.filter(function(x){return parseFloat(x.pnl)<0;}).length,pnl:ut.reduce(function(s,x){return s+(parseFloat(x.pnl)||0);},0),disciplineScore:calcDiscipline(ut,entryRiskMax,{commitment:existing.commitment||null}),riskMax:entryRiskMax,noTradeDay:ut.length>0?false:!!existing.noTradeDay});
    try{localStorage.setItem("journal:"+selectedDate.replace(/\//g,"-"),JSON.stringify(newEntry));}catch(e){}
    setPastSessions(function(arr){var found=arr.some(function(x){return x.date===selectedDate;});return found?arr.map(function(x){return x.date===selectedDate?newEntry:x;}):arr.concat([newEntry]);});
    setPastNewTrade(null);
    if(props.bumpReloadKey)props.bumpReloadKey();
    if(props.refreshHistory)props.refreshHistory();
  }
  function savePastTrade(updated){
    // CHANGED: Resolve the journal entry — past dates use pastSession, today uses todayJournalEntry,
    // falling back to a synthetic entry built from live state.trades if today has no saved journal yet.
    var sourceEntry=pastSession||(isToday?(todayJournalEntry||{date:todayStr(),pnl:0,trades:state.trades||[],wins:0,losses:0,disciplineScore:100,riskMax:parseFloat(settings.riskMax)||0}):null);
    if(!sourceEntry)return;
    var fn=props.autoAddViolations||function(x){return x;};
    // CHANGED: Run through migrateTrade so pnl/positionSize/pctPnl are recomputed from edited entries/exits.
    var enriched=migrateTrade(fn(updated,settings.positionMax));
    var ut=(sourceEntry.trades||[]).map(function(x){return x.id===enriched.id?enriched:x;});
    // CHANGED: Today's riskMax follows current settings (live day); a past day preserves its own.
    var entryRiskMax=isToday?(parseFloat(settings.riskMax)||0):((sourceEntry.riskMax!=null&&parseFloat(sourceEntry.riskMax)>0)?parseFloat(sourceEntry.riskMax):(parseFloat(settings.riskMax)||0));
    var newEntry=Object.assign({},sourceEntry,{trades:ut,wins:ut.filter(function(x){return parseFloat(x.pnl)>0;}).length,losses:ut.filter(function(x){return parseFloat(x.pnl)<0;}).length,pnl:ut.reduce(function(s,x){return s+(parseFloat(x.pnl)||0);},0),disciplineScore:calcDiscipline(ut,entryRiskMax,{commitment:(sourceEntry&&sourceEntry.commitment)||state.commitment||null}),riskMax:entryRiskMax,noTradeDay:ut.length>0?false:!!sourceEntry.noTradeDay});
    var dateKey=isToday?todayStr():selectedDate;
    var written=safeWriteJournalEntry("journal:"+dateKey.replace(/\//g,"-"),newEntry);
    if(written)newEntry=written;
    if(isToday){
      setTodayJournalEntry(newEntry);
      // CHANGED: Also update state.trades so live P&L stays consistent (with recomputed pnl).
      props.setState(function(s){return Object.assign({},s,{trades:(s.trades||[]).map(function(x){return x.id===enriched.id?enriched:x;})});});
    }else{
      setPastSessions(function(arr){return arr.map(function(x){return x.date===selectedDate?newEntry:x;});});
    }
    setEditingId(null);
    if(props.bumpReloadKey)props.bumpReloadKey();
    if(props.refreshHistory)props.refreshHistory();
  }
  function deletePastTrade(tradeId){
    // CHANGED: Handle today's journal too.
    var sourceEntry=pastSession||(isToday?todayJournalEntry:null);
    if(!sourceEntry)return;
    var ut=(sourceEntry.trades||[]).filter(function(x){return x.id!==tradeId;});
    // CHANGED: Today's riskMax follows current settings (live day); a past day preserves its own.
    var entryRiskMax=isToday?(parseFloat(settings.riskMax)||0):((sourceEntry.riskMax!=null&&parseFloat(sourceEntry.riskMax)>0)?parseFloat(sourceEntry.riskMax):(parseFloat(settings.riskMax)||0));
    var newEntry=Object.assign({},sourceEntry,{trades:ut,wins:ut.filter(function(x){return parseFloat(x.pnl)>0;}).length,losses:ut.filter(function(x){return parseFloat(x.pnl)<0;}).length,pnl:ut.reduce(function(s,x){return s+(parseFloat(x.pnl)||0);},0),disciplineScore:calcDiscipline(ut,entryRiskMax,{commitment:(sourceEntry&&sourceEntry.commitment)||state.commitment||null}),riskMax:entryRiskMax,noTradeDay:ut.length>0?false:!!sourceEntry.noTradeDay});
    var dateKey=isToday?todayStr():selectedDate;
    var written=safeWriteJournalEntry("journal:"+dateKey.replace(/\//g,"-"),newEntry);
    if(written)newEntry=written;
    if(isToday){
      setTodayJournalEntry(newEntry);
      props.setState(function(s){return Object.assign({},s,{trades:(s.trades||[]).filter(function(x){return x.id!==tradeId;})});});
    }else{
      setPastSessions(function(arr){return arr.map(function(x){return x.date===selectedDate?newEntry:x;});});
    }
    if(props.bumpReloadKey)props.bumpReloadKey();
    if(props.refreshHistory)props.refreshHistory();
  }
  var opts=props.tradeOptions||defaultOptions();
  var filterDefs=[
    {key:"direction",label:"Direction",options:["CALL","PUT"]},
    {key:"setup",label:"Setup",options:opts.setup},
    {key:"timeframe",label:"Timeframe",options:opts.timeframe},
    {key:"candlePattern",label:"Candle Pattern",options:opts.candlePattern},
    {key:"grade",label:"Setup Grade",options:["A","B","C"]},
    {key:"emotions",label:"Emotional State",options:opts.emotion},
    {key:"violations",label:"Rule Violations",options:ALL_VIOLATIONS}
  ];
  var activeFilterCount=Object.values(filters).filter(function(v){return v&&v.length>0;}).length;
  var displayTrades=rawTrades.slice().filter(function(t){return t.status!=="open";});
  filterDefs.forEach(function(fd){var sel=filters[fd.key];if(!sel||!sel.length)return;displayTrades=displayTrades.filter(function(t){if(fd.key==="emotions"||fd.key==="violations")return(t[fd.key]||[]).some(function(e){return sel.indexOf(e)>=0;});return sel.indexOf(t[fd.key])>=0;});});
  // CHANGED: Multi-level sort. Each sort id maps to a comparator; the chain applies them in
  // priority order, falling through to the next only when the current one ties. An empty chain
  // (or only "timestamp") defaults to chronological by openedAt.
  var SORT_CMP={
    timestamp:function(a,b){return(parseFloat(a.openedAt)||0)-(parseFloat(b.openedAt)||0);},
    pnl_pos:function(a,b){return(parseFloat(b.pnl)||0)-(parseFloat(a.pnl)||0);},
    pnl_neg:function(a,b){return(parseFloat(a.pnl)||0)-(parseFloat(b.pnl)||0);},
    pct_pos:function(a,b){return(parseFloat(b.pctPnl)||0)-(parseFloat(a.pctPnl)||0);},
    pct_neg:function(a,b){return(parseFloat(a.pctPnl)||0)-(parseFloat(b.pctPnl)||0);},
    size_pos:function(a,b){return(parseFloat(b.positionSize)||0)-(parseFloat(a.positionSize)||0);},
    size_neg:function(a,b){return(parseFloat(a.positionSize)||0)-(parseFloat(b.positionSize)||0);}
  };
  function makeChainCmp(chain,withDate){
    var ids=(chain&&chain.length)?chain:["timestamp"];
    return function(a,b){
      for(var i=0;i<ids.length;i++){
        var fn=SORT_CMP[ids[i]];if(!fn)continue;
        var r=fn(a,b);
        // For the cross-day list, the timestamp comparator should order by date first.
        if(withDate&&ids[i]==="timestamp"){var da=new Date(a.date).getTime()||0,db=new Date(b.date).getTime()||0;if(da!==db){r=da-db;}}
        if(r!==0)return r;
      }
      return 0;
    };
  }
  displayTrades=displayTrades.slice().sort(makeChainCmp(sortChain,false));
  // CHANGED: Build an "all journal" trade list (every date + today) with the SAME filters and sort
  // applied, so the all-screenshots view honors the Sort/Filter controls. Each trade carries its date.
  var allGalleryTrades=(function(){
    var all=[];
    try{
      loadJournalRows().forEach(function(entry){
        (entry.trades||[]).forEach(function(t){if(t.status!=="open")all.push(Object.assign({},t,{date:entry.date}));});
      });
      (state.trades||[]).forEach(function(t){if(t.status!=="open")all.push(Object.assign({},t,{date:todayStr()}));});
    }catch(e){}
    filterDefs.forEach(function(fd){var sel=filters[fd.key];if(!sel||!sel.length)return;all=all.filter(function(t){if(fd.key==="emotions"||fd.key==="violations")return(t[fd.key]||[]).some(function(e){return sel.indexOf(e)>=0;});return sel.indexOf(t[fd.key])>=0;});});
    all.sort(makeChainCmp(sortChain,true));
    return all;
  })();
  // CHANGED: The filter result count must reflect the list actually shown. In "All trades" mode that's
  // the cross-journal list; otherwise it's the current session's filtered list.
  var isAllScope=galleryScope==="all";
  var filterResultCount=isAllScope?allGalleryTrades.length:displayTrades.length;
  var filterTotalCount=isAllScope
    ?(function(){var n=0;try{loadJournalRows().forEach(function(e){(e.trades||[]).forEach(function(t){if(t.status!=="open")n++;});});(state.trades||[]).forEach(function(t){if(t.status!=="open")n++;});}catch(e){}return n;})()
    :rawTrades.filter(function(t){return t.status!=="open";}).length;
  var slippagePct=settings.slippagePct!=null?settings.slippagePct:20;
  return (
    <div style={{paddingTop:16}}>
      {isToday&&<EventWarningBanner windowMin={60}/>}
      {phase!=="closed"&&<CommitmentPanel state={props.state} setState={props.setState} phase={phase} settings={settings}/>}
      {/* CHANGED: Discipline lockout banner — date-aware. When viewing today, shows the active lock
          (if any). When viewing a past day that had a lock event saved on its journal row, shows
          the historical lock summary. Otherwise hidden. */}
      {(function(){
        var liveLock=checkDisciplineLock(state.trades,state.commitment);
        var isViewingToday=selectedDate===todayStr();
        // Determine what to show based on selected date.
        var mode=null,lock=null,entryNote="";
        if(isViewingToday&&liveLock.locked){
          mode="active";lock=liveLock;
          // Persist live lock metadata onto today's journal entry the first time we see it.
          var existingLockedAt=getJournalEntryField(liveLock.fromDate,"lockedAt");
          updateJournalEntryFields(liveLock.fromDate,{wasLocked:true,lockScore:liveLock.score,lockThreshold:loadDisciplineLockThreshold(),lockedAt:existingLockedAt||Date.now()});
        }else if(!isViewingToday){
          // Past day — check the journal entry for a recorded lock event.
          var wasLocked=getJournalEntryField(selectedDate,"wasLocked");
          if(wasLocked){
            mode="historical";
            lock={fromDate:selectedDate,score:getJournalEntryField(selectedDate,"lockScore")||0};
          }
        }
        if(!mode)return null;
        var thr=mode==="active"?loadDisciplineLockThreshold():(getJournalEntryField(lock.fromDate,"lockThreshold")||loadDisciplineLockThreshold());
        var openLive=(props.liveTrades||[]);
        var hasOpen=mode==="active"&&openLive.length>0;
        var clearMsg=mode==="active"?(lock.sameDay
          ? "This lock stays in place tomorrow and clears the day after. A weekend serves the cooldown, so a Friday lock clears Monday."
          : (lock.clearsIn===1?"This lock clears automatically tomorrow.":"This lock clears automatically after one full day.")):null;
        var headerLabel=mode==="active"
          ? (lock.sameDay
            ? "⚠ Half-Size Trading Active"
            : (function(){var d=daysBetween(lock.fromDate,todayStr());return "⚠ Half-Size Active · triggered "+(d===1?"yesterday":d+" days ago")+" ("+lock.fromDate+")";})())
          : "⚠ Half-Size Event — "+lock.fromDate;
        var bodyMsg=mode==="active"
          ? ((lock.sameDay?"Today's discipline score has dropped to ":"Your discipline score on "+lock.fromDate+" was ")+"")
          : ("Discipline score on this day was ");
        return (
          <div style={{marginBottom:10,padding:"10px 12px",background:"#1c0a0a",border:"1px solid #ef4444",borderRadius:8}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <span style={{fontSize:11,color:"#fca5a5",letterSpacing:1,textTransform:"uppercase",fontWeight:800}}>{headerLabel}</span>
              <span style={{fontSize:11,color:"#94a3b8"}}>· score {lock.score}/{thr}</span>
            </div>
            <div style={{fontSize:12,color:"#fecaca",lineHeight:1.5,marginBottom:6}}>{mode==="active"?"Position/risk auto-halved. Keep trading at half size.":"Position/risk were auto-halved this day."}</div>
            {clearMsg&&<div style={{fontSize:11,color:"#fbbf24",lineHeight:1.4,marginBottom:6}}>{clearMsg}</div>}
            {(function(){
              var saved=getJournalEntryField(lock.fromDate,"lockNote")||"";
              return (
                <details style={{marginTop:4}}>
                  <summary style={{fontSize:11,color:"#94a3b8",cursor:"pointer",userSelect:"none"}}>{saved?"📝 Reflection saved · edit":"+ Add reflection"}</summary>
                  <textarea defaultValue={saved} onChange={function(e){updateJournalEntryFields(lock.fromDate,{lockNote:e.target.value});}} placeholder={mode==="active"?"What broke down? What's the plan for next session?":"Write your reflection..."} style={{width:"100%",marginTop:6,padding:"8px 10px",background:"#0a0a0f",border:"1px solid #7f1d1d",borderRadius:6,color:"#e2e8f0",fontSize:13,fontFamily:"inherit",lineHeight:1.5,minHeight:60,resize:"vertical",boxSizing:"border-box"}}/>
                </details>
              );
            })()}
          </div>
        );
      })()}
      {/* CHANGED: Daily R stop warning banner — fires at 80%+ of either stop, before hard block. */}
      {phase!=="closed"&&(function(){
        var rule=getSessions(settings).find(function(x){return x.id===phase;});
        if(!rule)return null;
        var riskMaxNum=parseFloat(settings.riskMax)||0;
        if(riskMaxNum<=0)return null;
        var rStops=getSessionRStops(rule);
        var dayR=totalPnL/riskMaxNum;
        // Loss approaching
        if(dayR<0&&dayR<=rStops.lossR*0.8&&dayR>rStops.lossR){
          var pct=Math.round(dayR/rStops.lossR*100);
          return (
            <div style={{marginBottom:10,padding:"6px 10px",background:"#1c0a0a66",border:"1px solid #b91c1c",borderRadius:6,display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:14}}>⚠</span>
              <span style={{fontSize:11,color:"#fca5a5",fontWeight:600}}>Approaching loss stop · {dayR.toFixed(2)}R / {rStops.lossR.toFixed(1)}R ({pct}%)</span>
            </div>
          );
        }
        // Gain approaching
        if(dayR>0&&dayR>=rStops.gainR*0.8&&dayR<rStops.gainR){
          var gpct=Math.round(dayR/rStops.gainR*100);
          return (
            <div style={{marginBottom:10,padding:"6px 10px",background:"#0a1f1066",border:"1px solid #15803d",borderRadius:6,display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:14}}>✓</span>
              <span style={{fontSize:11,color:"#86efac",fontWeight:600}}>Approaching gain stop · +{dayR.toFixed(2)}R / +{rStops.gainR.toFixed(1)}R ({gpct}%)</span>
            </div>
          );
        }
        // Hit hard stop — show the locked state explicitly
        if(dayR<=rStops.lossR){
          return (
            <div style={{marginBottom:10,padding:"8px 12px",background:"#1c0a0a",border:"1px solid #ef4444",borderRadius:8}}>
              <div style={{fontSize:11,color:"#fca5a5",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Loss Stop Hit · Trading Locked</div>
              <div style={{fontSize:12,color:"#fecaca",marginTop:2}}>Day at {dayR.toFixed(2)}R · stop {rStops.lossR.toFixed(1)}R. Step away.</div>
            </div>
          );
        }
        if(dayR>=rStops.gainR){
          return (
            <div style={{marginBottom:10,padding:"8px 12px",background:"#0a1f10",border:"1px solid #22c55e",borderRadius:8}}>
              <div style={{fontSize:11,color:"#86efac",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Gain Stop Hit · Take the Win</div>
              <div style={{fontSize:12,color:"#bbf7d0",marginTop:2}}>Day at +{dayR.toFixed(2)}R · target +{rStops.gainR.toFixed(1)}R. Done for the day.</div>
            </div>
          );
        }
        return null;
      })()}
      {/* CHANGED: Conditions banner removed entirely (feature deprecated). */}
      {/* CHANGED: Position/Risk strip removed from journal — shown in the New Trade form instead. */}
      {phase!=="closed"&&<SessionStrategy phase={phase} preCheckComplete={preCheckComplete} settings={settings}/>}
      {phase!=="closed"&&isToday&&props.liveTrades&&props.liveTrades.length>0&&(
        <div style={CS({marginBottom:16,border:"1px solid #ea580c",background:"#1c1108"})}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:"#fb923c",boxShadow:"0 0 8px #fb923c"}}/>
            <span style={{fontSize:13,color:"#fb923c",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Live Trades</span>
            <span style={{fontSize:11,color:"#fdba74",fontWeight:600,background:"#7c2d1244",padding:"1px 7px",borderRadius:3}}>{props.liveTrades.length} open</span>
          </div>
          {props.liveTrades.map(function(lt){
            var cls=getAssetClass(lt.assetClass);
            var entries=lt.entries||[];
            var totalC=entries.reduce(function(s,e){return s+(parseFloat(e.contracts)||0);},0);
            var totalCost=entries.reduce(function(s,e){return s+(parseFloat(e.contracts)||0)*(parseFloat(e.price)||0);},0);
            var avgEntry=totalC>0?totalCost/totalC:NaN;
            var totalExitC=(lt.exits||[]).reduce(function(s,e){return s+(parseFloat(e.contracts)||0);},0);
            var remaining=totalC-totalExitC;
            var dirColor=getDirectionColor(lt.direction);
            return (
              <button key={lt.id} onClick={function(){props.openLiveTrade(lt);}} style={{width:"100%",display:"block",textAlign:"left",padding:"10px 12px",marginBottom:6,background:"#0a0a0f",border:"1px solid #334155",borderRadius:8,cursor:"pointer",fontFamily:"inherit"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0,flexWrap:"wrap"}}>
                    {lt.instrument&&<span style={{fontSize:13,fontWeight:700,color:"#cbd5e1",letterSpacing:0.5}}>{lt.instrument}</span>}
                    {lt.direction&&<span style={{fontSize:11,padding:"2px 7px",borderRadius:4,background:dirColor==="#22c55e"?"#14532d":dirColor==="#ef4444"?"#7f1d1d":"#1e293b",color:dirColor==="#22c55e"?"#86efac":dirColor==="#ef4444"?"#fca5a5":"#94a3b8",fontWeight:700,letterSpacing:0.5}}>{lt.direction}{(lt.strike!=null&&lt.strike!==""&&!isNaN(parseFloat(lt.strike)))?(" $"+(function(){var n=parseFloat(lt.strike);return n%1===0?n.toFixed(0):n.toString();})()):""}</span>}
                    <span style={{fontSize:11,color:"#94a3b8"}}>{cls.label}</span>
                  </div>
                  <span style={{fontSize:11,color:"#fb923c",fontWeight:600,flexShrink:0}}>Manage →</span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6,fontSize:11,color:"#94a3b8"}}>
                  {!isNaN(avgEntry)&&<span>Avg entry <span style={{color:"#e2e8f0",fontWeight:600}}>${avgEntry.toFixed(2)}</span></span>}
                  <span>{remaining} {remaining===1?cls.unitSingular:cls.unit} open</span>
                  {lt.openedAt&&<span style={{color:"#64748b"}}>· opened {fmtTime(new Date(lt.openedAt))}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {/* CHANGED: Sticky Journal controls — date picker, add trade, sort, filter stay pinned while scrolling. */}
      <div style={{position:"sticky",top:66,zIndex:200,background:"#0a0a0f",paddingTop:8,marginBottom:14,borderBottom:"1px solid #1e293b"}}>
      {/* CHANGED: On mobile, the action button (which may be a long "Complete pre-market
         checklist first" label) wraps to its own row so it can't overlap the Today pill /
         All trades button. Desktop stays as a single row. */}
      <div style={{display:"flex",flexDirection:props.mobile?"column":"row",justifyContent:"space-between",alignItems:props.mobile?"stretch":"center",marginBottom:10,position:"relative",gap:props.mobile?8:12}}>
        <div style={{display:"flex",alignItems:"center",gap:props.mobile?8:10,minWidth:0,flexWrap:"wrap"}}>
          <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0"}}>Journal</div>
          <button onClick={function(){setGalleryScope("session");setPickerOpen(function(o){return !o;});}} style={{padding:"6px 12px",background:galleryScope==="session"?"#1e1b4b":"#111118",border:"1px solid "+(galleryScope==="session"?"#4338ca":"#334155"),borderRadius:6,color:galleryScope==="session"?"#a5b4fc":"#cbd5e1",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap"}}>📅 {isToday?"Today":selectedDate}<span style={{fontSize:11,opacity:0.7}}>▾</span></button>
          <button onClick={function(){setGalleryScope("all");}} style={{padding:"6px 12px",background:galleryScope==="all"?"#1e1b4b":"#111118",border:"1px solid "+(galleryScope==="all"?"#4338ca":"#334155"),borderRadius:6,color:galleryScope==="all"?"#a5b4fc":"#cbd5e1",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>All trades</button>
        </div>
        <div style={{display:"flex",gap:8,width:props.mobile?"100%":"auto"}}>
          {/* CHANGED: On mobile, the action button stretches to the full row width below the header pills. */}
          {isToday&&(tradeStatus.ok
            ?<button onClick={function(){var t=mkTrade();t.sessionId=phase!=="closed"?phase:null;setTrade(t);setShowForm(true);}} style={{padding:props.mobile?"10px 12px":"8px 16px",background:"#4f46e5",color:"#fff",border:"none",borderRadius:6,fontSize:props.mobile?13:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flex:props.mobile?1:"none"}}>+ New Trade</button>
            :<button disabled title={tradeStatus.reason||"Not available"} style={{padding:props.mobile?"10px 12px":"8px 16px",background:"#1e293b",color:"#475569",border:"1px solid #334155",borderRadius:6,fontSize:props.mobile?12:14,fontWeight:600,cursor:"not-allowed",fontFamily:"inherit",whiteSpace:"normal",flex:props.mobile?1:"none",lineHeight:1.2}}>{tradeStatus.reason||"Unavailable"}</button>
          )}
          {!isToday&&<button onClick={function(){var t=mkTrade();setPastNewTrade(Object.assign({},t,{time:new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}));}} style={{padding:props.mobile?"10px 12px":"8px 16px",background:"#4f46e5",color:"#fff",border:"none",borderRadius:6,fontSize:props.mobile?13:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flex:props.mobile?1:"none"}}>+ Add Trade</button>}
        </div>
        {pickerOpen&&<CalendarPicker selectedDate={selectedDate} onSelect={function(d){setSelectedDate(d);setPickerOpen(false);}} onClose={function(){setPickerOpen(false);}} todayPnL={totalPnL} riskMax={parseFloat(settings.riskMax)||0} settings={settings} todayTrades={state.trades}/>}
      </div>
      <div style={{display:"flex",gap:8,position:"relative"}}>
        <div style={{position:"relative",flex:1}}>
          <button onClick={function(){setSortOpen(function(o){return !o;});setFilterOpen(false);}} style={{width:"100%",padding:"8px 12px",background:sortChain.length>0?"#1e1b4b":"#111118",border:"1px solid "+(sortChain.length>0?"#4338ca":"#334155"),borderRadius:6,color:sortChain.length>0?"#a5b4fc":"#64748b",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>Sort{sortChain.length>0?" ("+sortChain.length+")":""}</span><span style={{fontSize:12}}>▾</span>
          </button>
          {sortOpen&&(
            <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#1e293b",border:"1px solid #334155",borderRadius:8,zIndex:300,overflow:"hidden",boxShadow:"0 8px 24px #00000088",marginTop:4}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 14px",borderBottom:"1px solid #334155"}}>
                <span style={{fontSize:11,color:"#64748b",letterSpacing:0.5}}>Tap to add · number = priority</span>
                {sortChain.length>0&&<button onClick={function(){setSortChain([]);}} style={{background:"none",border:"none",color:"#f87171",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>}
              </div>
              {[{id:"timestamp",label:"Timestamp",field:"time"},{id:"pnl_pos",label:"P&L $ (Best First)",field:"pnl"},{id:"pnl_neg",label:"P&L $ (Worst First)",field:"pnl"},{id:"pct_pos",label:"P&L % (Best First)",field:"pct"},{id:"pct_neg",label:"P&L % (Worst First)",field:"pct"},{id:"size_pos",label:"Position Size (Largest First)",field:"size"},{id:"size_neg",label:"Position Size (Smallest First)",field:"size"}].map(function(opt,oi,arr){
                var rank=sortChain.indexOf(opt.id);
                var active=rank>=0;
                return <button key={opt.id} onClick={function(){
                  setSortChain(function(chain){
                    var idx=chain.indexOf(opt.id);
                    if(idx>=0){return chain.filter(function(x){return x!==opt.id;});}
                    // Remove any other option for the same field (opposite direction), then append.
                    var sameField=arr.filter(function(o){return o.field===opt.field;}).map(function(o){return o.id;});
                    var pruned=chain.filter(function(x){return sameField.indexOf(x)<0;});
                    return pruned.concat([opt.id]);
                  });
                }} style={{width:"100%",padding:"10px 14px",background:active?"#1e1b4b":"transparent",border:"none",borderBottom:"1px solid #334155",color:active?"#a5b4fc":"#cbd5e1",fontSize:14,cursor:"pointer",fontFamily:"inherit",textAlign:"left",display:"flex",alignItems:"center",gap:10}}>
                  <span style={{width:18,height:18,flexShrink:0,borderRadius:4,border:"1px solid "+(active?"#6366f1":"#475569"),background:active?"#4338ca":"transparent",color:"#fff",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{active?(rank+1):""}</span>
                  <span style={{flex:1}}>{opt.label}</span>
                </button>;
              })}
            </div>
          )}
        </div>
        <div style={{position:"relative",flex:1}}>
          <button onClick={function(){setFilterOpen(function(o){return !o;});setSortOpen(false);}} style={{width:"100%",padding:"8px 12px",background:activeFilterCount>0?"#1e1b4b":"#111118",border:"1px solid "+(activeFilterCount>0?"#4338ca":"#334155"),borderRadius:6,color:activeFilterCount>0?"#a5b4fc":"#64748b",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>Filter{activeFilterCount>0?" ("+activeFilterCount+") · "+filterResultCount+" result"+(filterResultCount===1?"":"s"):""}</span><span style={{fontSize:12}}>▾</span>
          </button>
          {filterOpen&&(
            <div style={{position:"absolute",top:"100%",right:0,left:0,background:"#1e293b",border:"1px solid #334155",borderRadius:8,zIndex:300,boxShadow:"0 8px 24px #00000088",marginTop:4,padding:"10px 12px",maxHeight:360,overflowY:"auto"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <span style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Filters{activeFilterCount>0?" · "+filterResultCount+"/"+filterTotalCount:""}</span>
                {activeFilterCount>0&&<button onClick={function(){setFilters({});}} style={{background:"none",border:"none",color:"#f87171",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Clear all</button>}
              </div>
              {filterDefs.map(function(fd){var selected=filters[fd.key]||[];return <div key={fd.key} style={{marginBottom:10}}><div style={{fontSize:12,color:"#6366f1",letterSpacing:1,textTransform:"uppercase",marginBottom:6,fontWeight:600}}>{fd.label}</div><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{fd.options.map(function(opt){var active=selected.indexOf(opt)>=0;return <button key={opt} onClick={function(){setFilters(function(f){var cur=f[fd.key]||[];var next=active?cur.filter(function(x){return x!==opt;}):[].concat(cur,[opt]);return Object.assign({},f,{[fd.key]:next});});}} style={{padding:"4px 10px",background:active?"#4f46e5":"#0a0a0f",border:"1px solid "+(active?"#6366f1":"#334155"),borderRadius:4,color:active?"#fff":"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{opt}</button>;})}</div></div>;})}
            </div>
          )}
        </div>
      </div>
      </div>
      {isToday&&showForm&&trade&&<TradeForm mobile={props.mobile} trade={trade} setTrade={setTrade} onSave={saveTrade} onCancel={function(){setShowForm(false);setTrade(null);}} settings={settings} tradeOptions={props.tradeOptions} displayPosMin={props.displayPosMin} displayPosMax={props.displayPosMax} displayRiskMin={props.displayRiskMin} displayRiskMax={props.displayRiskMax}/>}
      {!isToday&&pastNewTrade&&<TradeForm mobile={props.mobile} trade={pastNewTrade} setTrade={setPastNewTrade} onSave={saveNewPastTrade} onCancel={function(){setPastNewTrade(null);}} settings={settings} tradeOptions={props.tradeOptions} displayPosMin={props.displayPosMin} displayPosMax={props.displayPosMax} displayRiskMin={props.displayRiskMin} displayRiskMax={props.displayRiskMax}/>}
      {/* CHANGED: Screenshots moved here from Home. Built from the filtered + sorted trade list so
          Sort/Filter apply. A scope toggle switches between this date's shots and all journal shots. */}
      {(function(){
        var galleryTrades=galleryScope==="all"?allGalleryTrades:displayTrades;
        var hasAnyShots=galleryTrades.some(function(t){return (t.screenshots||[]).length>0;});
        if(!hasAnyShots&&galleryScope==="session"){
          // If the current date has no shots but the whole journal does, still show the toggle so the user can switch.
          var allHasShots=allGalleryTrades.some(function(t){return (t.screenshots||[]).length>0;});
          if(!allHasShots)return null;
        }
        return (
          <div style={{marginBottom:16}}>
            <PhotoGallery trades={galleryTrades} galleryDate={selectedDate} title={galleryScope==="all"?"All Screenshots":"Screenshots"} alwaysOpen={true}/>
          </div>
        );
      })()}
      {/* CHANGED: Notebook — collates all trade notes + end-of-day notes across the journal. */}
      <NotebookPanel todayState={props.state}/>
      {galleryScope==="all"?(function(){
        // CHANGED: "All trades" — list every saved trade across the whole journal (filtered + sorted),
        // PLUS no-trade days as marker tiles. Grouped by date with ONE date header per group, then
        // a 3-column grid of compact trade cards (or a single no-trade marker for sit-out days).
        // Mobile collapses to single column via responsive grid below.
        // Build grouped structure: each group is {date, isNoTradeDay, reasons?, trades:[]}.
        var byDate={};var ord=[];
        allGalleryTrades.forEach(function(t){if(!byDate[t.date]){byDate[t.date]={date:t.date,isNoTradeDay:false,trades:[]};ord.push(t.date);}byDate[t.date].trades.push(t);});
        // Merge no-trade days from journal rows (only when no other filters are active — filters scope
        // to trade fields and a no-trade day has no trade to match against).
        if(activeFilterCount===0){
          try{
            loadJournalRows().forEach(function(r){
              if(r&&r.noTradeDay&&!byDate[r.date]){byDate[r.date]={date:r.date,isNoTradeDay:true,reasons:r.noTradeReasons||[],note:r.note||"",trades:[]};ord.push(r.date);}
            });
          }catch(e){}
        }
        // Sort groups by date descending (most recent first).
        ord.sort(function(a,b){return new Date(b)-new Date(a);});
        if(ord.length===0)return <div style={{textAlign:"center",padding:"40px 20px",borderTop:"1px dashed #1e293b",marginTop:8}}><div style={{fontSize:14,color:"#475569"}}>{activeFilterCount>0?"No trades match your filters":"No trades saved yet"}</div></div>;
        var totalTrades=allGalleryTrades.length;
        return (
          <div>
            <div style={{fontSize:12,color:"#64748b",marginBottom:10}}>{totalTrades} {totalTrades===1?"trade":"trades"} across all sessions{activeFilterCount>0?" (filtered)":""}</div>
            {ord.map(function(d){
              var g=byDate[d];
              var label=d===todayStr()?"Today":d;
              return (
                <div key={d} style={{marginBottom:14}}>
                  <div style={{fontSize:11,color:"#64748b",fontWeight:700,letterSpacing:0.5,margin:"4px 2px 6px",textTransform:"uppercase"}}>{label}{g.isNoTradeDay?" · No-Trade Day":""}</div>
                  {g.isNoTradeDay?(
                    <div style={{padding:"10px 12px",background:"#0a0a0f",border:"1px dashed #4338ca44",borderRadius:8}}>
                      <div style={{fontSize:12,color:"#a5b4fc",fontWeight:700,marginBottom:4}}>⊘ Sat out</div>
                      {g.reasons&&g.reasons.length>0&&<div style={{fontSize:11,color:"#94a3b8"}}>{g.reasons.join(" · ")}</div>}
                      {g.note&&<div style={{fontSize:11,color:"#64748b",marginTop:4,fontStyle:"italic",lineHeight:1.4}}>{g.note}</div>}
                    </div>
                  ):(
                    <div style={{display:"grid",gridTemplateColumns:props.mobile?"1fr":"repeat(3, minmax(0,1fr))",gap:8}}>
                      {g.trades.map(function(t,i){return (
                        <TradeTile key={(t.id||"")+"_"+i} t={t} i={i} posMax={settings.positionMax} hideControls={true}/>
                      );})}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })():(
        <React.Fragment>
      {displayTrades.length===0&&!showForm&&<div style={{textAlign:"center",padding:"40px 20px",borderTop:"1px dashed #1e293b",marginTop:8}}><div style={{fontSize:14,color:"#475569"}}>{rawTrades.length===0?(isToday?"No trades logged yet today":"No trades recorded for this session"):"No trades match your filters"}</div></div>}
      {/* CHANGED: No-Trade Day — when today has no trades and isn't yet saved, let the user record WHY
          they sat out (a disciplined decision worth journaling) and save a no-trade journal entry.
          Hidden when the market is closed today (weekend/holiday) — sitting out isn't a decision then. */}
      {isToday&&!todayJournalEntry&&(state.trades||[]).length===0&&!showForm&&(function(){
        var d=getNow().getDay();
        var marketClosedToday=!!MARKET_HOLIDAYS[todayStr()]||d===0||d===6;
        if(marketClosedToday)return null;
        return (
        <div style={CS({marginTop:14,border:"1px solid #4338ca44"})}>
          <div style={{fontSize:13,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",marginBottom:6,fontWeight:600}}>No-Trade Day</div>
          <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Didn't take any trades today? Note why — sitting out is a valid, disciplined choice worth recording.</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
            {["No A+ setups","Choppy / no trend","High-impact news","Not focused","Rules kept me out","Already hit goal","Personal / away"].map(function(reason){
              var picked=(state.noTradeReasons||[]).indexOf(reason)>=0;
              return <button key={reason} onClick={function(){props.setState(function(s){var arr=(s.noTradeReasons||[]).slice();var idx=arr.indexOf(reason);if(idx>=0)arr.splice(idx,1);else arr.push(reason);return Object.assign({},s,{noTradeReasons:arr});});}} style={{padding:"5px 10px",background:picked?"#1e1b4b":"#0a0a0f",border:"1px solid "+(picked?"#6366f1":"#334155"),borderRadius:14,color:picked?"#a5b4fc":"#94a3b8",fontSize:12,fontWeight:picked?700:500,cursor:"pointer",fontFamily:"inherit"}}>{picked?"✓ ":""}{reason}</button>;
            })}
          </div>
          <textarea value={state.noTradeReason||""} onChange={function(e){var v=e.target.value;props.setState(function(s){return Object.assign({},s,{noTradeReason:v});});}} placeholder="Add detail (optional) — what kept you out today?" style={Object.assign({},fld,{minHeight:70,resize:"vertical",fontFamily:"inherit",lineHeight:1.5,marginBottom:10})}/>
          {/* CHANGED: Optional chart screenshots showing why you sat out (e.g. a choppy tape). */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <label style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Screenshots {(state.noTradeShots||[]).length>0&&<span style={{color:"#475569",fontWeight:400,marginLeft:4}}>({(state.noTradeShots||[]).length})</span>}</label>
            <button onClick={function(){if(noTradeShotRef.current)noTradeShotRef.current.click();}} disabled={uploadingNoTradeShot} style={{padding:"4px 10px",background:uploadingNoTradeShot?"#1e293b":"#0c2b3d",border:"1px solid "+(uploadingNoTradeShot?"#334155":"#38bdf8"),borderRadius:6,color:uploadingNoTradeShot?"#475569":"#38bdf8",fontSize:12,fontWeight:600,cursor:uploadingNoTradeShot?"not-allowed":"pointer",fontFamily:"inherit"}}>{uploadingNoTradeShot?"Uploading...":"+ Add Image"}</button>
          </div>
          <input ref={noTradeShotRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={function(e){
            var files=Array.from(e.target.files||[]);
            if(files.length===0)return;
            setNoTradeShotError(null);setUploadingNoTradeShot(true);
            Promise.all(files.map(function(f){return compressImage(f);}))
              .then(function(dataUrls){props.setState(function(s){return Object.assign({},s,{noTradeShots:(s.noTradeShots||[]).concat(dataUrls)});});setUploadingNoTradeShot(false);})
              .catch(function(err){setNoTradeShotError("Upload failed: "+(err.message||"unknown"));setUploadingNoTradeShot(false);});
            e.target.value="";
          }}/>
          {noTradeShotError&&<div style={{fontSize:12,color:"#fca5a5",marginBottom:6}}>{noTradeShotError}</div>}
          {(state.noTradeShots||[]).length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(80px,1fr))",gap:6,marginBottom:10}}>
              {(state.noTradeShots||[]).map(function(src,si){
                return (
                  <div key={si} style={{position:"relative",aspectRatio:"1",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,overflow:"hidden"}}>
                    <img src={src} alt={"Screenshot "+(si+1)} onClick={function(){setNoTradeViewer(src);}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer",display:"block"}}/>
                    <button onClick={function(){props.setState(function(s){var copy=(s.noTradeShots||[]).slice();copy.splice(si,1);return Object.assign({},s,{noTradeShots:copy});});}} aria-label="Remove" style={{position:"absolute",top:3,right:3,width:18,height:18,padding:0,background:"#000000cc",border:"1px solid #475569",borderRadius:"50%",color:"#fca5a5",fontSize:11,cursor:"pointer",fontFamily:"inherit",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
          {(state.noTradeShots||[]).length===0&&!uploadingNoTradeShot&&<div style={{fontSize:11,color:"#64748b",fontStyle:"italic",marginBottom:10}}>Optional. Images are compressed before saving.</div>}
          <button onClick={function(){
            var key="journal:"+todayStr().replace(/\//g,"-");
            var entry={
              date:todayStr(),
              pnl:0,
              trades:[],
              note:state.dailyNote||"",
              noTradeReason:state.noTradeReason||"",
              noTradeReasons:state.noTradeReasons||[],
              noTradeShots:state.noTradeShots||[],
              noTradeDay:true,
              noTradeLoggedAt:Date.now(),
              ruleViolations:[],
              commitment:state.commitment||null,
              wins:0,losses:0,
              riskMax:parseFloat(settings.riskMax)||0,
              // CHANGED: A logged no-trade day represents a deliberately disciplined choice —
              // sitting out is the cleanest expression of discipline. Score it 100 so it
              // counts toward weekly averages, streaks, and the Iron Mind achievement.
              disciplineScore:100
            };
            try{
              localStorage.setItem(key,JSON.stringify(entry));
              setTodayJournalEntry(entry);
              if(props.bumpReloadKey)props.bumpReloadKey();
              if(props.refreshHistory)props.refreshHistory();
            }catch(e){alert("Failed to save: "+e.message);}
          }} style={{width:"100%",padding:"11px",background:"#0f1f15",border:"1px solid #166534",borderRadius:8,color:"#86efac",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Log No-Trade Day</button>
        </div>
        );
      })()}
      <div style={{display:"grid",gridTemplateColumns:props.mobile?"1fr":"1fr 1fr 1fr",gap:12,alignItems:"stretch"}}>
      {displayTrades.map(function(t,i){
        var isEditing=editingId===t.id;
        if(!isToday){
          return (
            <div key={t.id||i} style={isEditing?{gridColumn:"1 / -1"}:null}>
              {isEditing
                ?<TradeForm trade={editDraft||t} setTrade={function(updater){setEditDraft(function(prev){var base=prev||t;return typeof updater==="function"?updater(base):updater;});}} onSave={function(updated){savePastTrade(updated);setEditDraft(null);}} onCancel={cancelEdit} settings={settings} tradeOptions={props.tradeOptions}/>
                :<TradeTile t={t} i={i} posMax={settings.positionMax} onDelete={function(){deletePastTrade(t.id);}} onEdit={function(){startEdit(t);}}/>
              }
            </div>
          );
        }
        return (
          <div key={t.id} style={isEditing?{gridColumn:"1 / -1"}:null}>
            {isEditing
              ?<TradeForm trade={editDraft||t} setTrade={function(updater){setEditDraft(function(prev){var base=prev||t;return typeof updater==="function"?updater(base):updater;});}} onSave={function(updated){savePastTrade(updated);setEditDraft(null);}} onCancel={cancelEdit} settings={settings} tradeOptions={props.tradeOptions}/>
              :<TradeTile t={t} i={i} posMax={settings.positionMax} onDelete={function(){deleteTrade(t.id);}} onEdit={function(){startEdit(t);}}/>
            }
          </div>
        );
      })}
      </div>
      {/* CHANGED: Day summary + note editor. Shows for past dates always, and today after save-to-journal. */}
      {((!isToday&&pastSession)||(isToday&&todayJournalEntry))&&(function(){
        var entry=isToday?todayJournalEntry:pastSession;
        var sTrades=entry.trades||[];
        var sPnl=parseFloat(entry.pnl)||0;
        var wins=sTrades.filter(function(t){return parseFloat(t.pnl)>0;}).length;
        var losses=sTrades.filter(function(t){return parseFloat(t.pnl)<0;}).length;
        var bes=sTrades.filter(function(t){return Math.abs(parseFloat(t.pnl)||0)<0.01;}).length;
        // CHANGED: Use the stored disciplineScore (kept in sync by the commitment-edit handler + the
        // one-time migration). Recomputing live here can disagree with the journal/performance
        // displays when commitment context differs.
        var disc=(entry.disciplineScore!=null
          ? parseFloat(entry.disciplineScore)
          : calcDiscipline(sTrades,entry.riskMax,{commitment:entry.commitment||(isToday?(props.state&&props.state.commitment):null)||null}));
        return (
          <div style={CS({marginTop:18,border:"1px solid "+(isToday?"#16653444":"#1e293b")})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:13,color:isToday?"#86efac":"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>{isToday?"Saved to Journal ✓":"Day Summary"}</div>
            </div>
            {entry.noTradeDay&&((entry.noTradeReasons||[]).length>0||entry.noTradeReason||entry.noTradeLoggedAt)&&<div style={{marginBottom:12,padding:"10px 12px",background:"#0a0a0f",border:"1px solid #4338ca44",borderRadius:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:6}}>
                <span style={{fontSize:10,fontWeight:800,color:"#fcd34d",background:"#1c1408",border:"1px solid #a16207",borderRadius:4,padding:"2px 7px",letterSpacing:0.5,flexShrink:0}}>⊘ NO-TRADE DAY</span>
                {entry.noTradeLoggedAt&&<span style={{fontSize:10,color:"#64748b",flexShrink:0}}>logged {(function(){try{var d=new Date(entry.noTradeLoggedAt);return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}catch(e){return "";}})()}</span>}
              </div>
              {(entry.noTradeReasons||[]).length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:entry.noTradeReason?8:0}}>{(entry.noTradeReasons||[]).map(function(r){return <span key={r} style={{fontSize:11,color:"#a5b4fc",background:"#1e1b4b",border:"1px solid #4338ca",borderRadius:12,padding:"2px 9px",fontWeight:600}}>{r}</span>;})}</div>}
              {entry.noTradeReason&&<div style={{fontSize:13,color:"#cbd5e1",lineHeight:1.5}}>{entry.noTradeReason}</div>}
            </div>}
            {/* CHANGED: Day was initially saved as no-trade, then trades were taken. Preserve the original sit-out reasons as historical context. */}
            {!entry.noTradeDay&&((entry.initialNoTradeReasons||[]).length>0||entry.initialNoTradeReason)&&<div style={{marginBottom:12,padding:"10px 12px",background:"#0a0a0f",border:"1px dashed #a16207",borderRadius:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:6}}>
                <div style={{fontSize:10,color:"#fbbf24",textTransform:"uppercase",letterSpacing:0.5,fontWeight:600}}>Initially planned as no-trade</div>
                {entry.initialNoTradeLoggedAt&&<span style={{fontSize:10,color:"#64748b"}}>logged {(function(){try{var d=new Date(entry.initialNoTradeLoggedAt);return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}catch(e){return "";}})()}</span>}
              </div>
              {(entry.initialNoTradeReasons||[]).length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:entry.initialNoTradeReason?8:0}}>{(entry.initialNoTradeReasons||[]).map(function(r){return <span key={r} style={{fontSize:11,color:"#fcd34d",background:"#1c1408",border:"1px solid #a16207",borderRadius:12,padding:"2px 9px",fontWeight:600}}>{r}</span>;})}</div>}
              {entry.initialNoTradeReason&&<div style={{fontSize:13,color:"#cbd5e1",lineHeight:1.5}}>{entry.initialNoTradeReason}</div>}
              <div style={{fontSize:11,color:"#64748b",marginTop:6,fontStyle:"italic"}}>Took trades anyway — review whether the setup justified the change of plan.</div>
            </div>}
            {entry.noTradeDay&&(entry.noTradeShots||[]).length>0&&<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(80px,1fr))",gap:6,marginBottom:12}}>{(entry.noTradeShots||[]).map(function(src,si){return <div key={si} style={{aspectRatio:"1",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,overflow:"hidden"}}><img src={src} alt={"Screenshot "+(si+1)} onClick={function(){setNoTradeViewer(src);}} style={{width:"100%",height:"100%",objectFit:"cover",cursor:"pointer",display:"block"}}/></div>;})}</div>}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:14}}>
              <div style={{padding:"8px 10px",background:"#111118",border:"1px solid #1e293b",borderRadius:6}}>
                <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:0.5}}>P&L</div>
                <div style={{fontSize:16,fontWeight:700,color:sPnl>=0?"#22c55e":"#ef4444",marginTop:3}}>{HIDE_DOLLAR_PNL?(function(){var dateKey=isToday?todayStr():selectedDate;var startBal=getAccountBalanceAtDate(dateKey);var pct=startBal>0?(sPnl/startBal*100):0;return (pct>=0?"+":"")+pct.toFixed(2)+"%";})():((sPnl>=0?"+":"-")+"$"+Math.abs(sPnl).toFixed(2))}</div>
              </div>
              <div style={{padding:"8px 10px",background:"#111118",border:"1px solid #1e293b",borderRadius:6}}>
                <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:0.5}}>W/L/BE</div>
                <div style={{fontSize:14,fontWeight:700,marginTop:3}}>
                  <span style={{color:"#22c55e"}}>{wins}</span>
                  <span style={{color:"#fff"}}>/</span>
                  <span style={{color:"#ef4444"}}>{losses}</span>
                  <span style={{color:"#fff"}}>/</span>
                  <span style={{color:"#94a3b8"}}>{bes}</span>
                </div>
              </div>
              <div style={{padding:"8px 10px",background:"#111118",border:"1px solid #1e293b",borderRadius:6}}>
                <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:0.5}}>Trades</div>
                <div style={{fontSize:16,fontWeight:700,color:"#cbd5e1",marginTop:3}}>{sTrades.length}</div>
              </div>
              <div style={{padding:"8px 10px",background:"#111118",border:"1px solid #1e293b",borderRadius:6}}>
                <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:0.5}}>Discipline</div>
                <div style={{fontSize:16,fontWeight:700,color:disc>=80?"#22c55e":disc>=60?"#fbbf24":"#ef4444",marginTop:3}}>{disc}</div>
              </div>
            </div>
            {/* CHANGED: COMMITMENT REVIEW — shows once the day is saved to the journal (the enclosing
                block already gates on todayJournalEntry) and a commitment was made. */}
            {isToday&&(function(){
              var sc=scoreCommitment(props.state);
              if(!sc)return null;
              var aff=props.state.commitment.setupsReviewAffirmed;
              function setAff(val){
                props.setState(function(s){var com=Object.assign({},s.commitment,{setupsReviewAffirmed:val,reviewed:true});return Object.assign({},s,{commitment:com});});
                // CHANGED: Persist the updated score so Performance/lock views stay consistent with the review.
                if(isToday&&todayJournalEntry){
                  try{
                    var newCom=Object.assign({},props.state.commitment,{setupsReviewAffirmed:val,reviewed:true});
                    var et=todayJournalEntry.trades||[];
                    var updated=Object.assign({},todayJournalEntry,{commitment:newCom,disciplineScore:calcDiscipline(et,todayJournalEntry.riskMax,{commitment:newCom})});
                    localStorage.setItem("journal:"+todayStr().replace(/\//g,"-"),JSON.stringify(updated));
                    setTodayJournalEntry(updated);
                    if(props.bumpReloadKey)props.bumpReloadKey();
                  }catch(e){}
                }
              }
              return (
                <div style={{marginBottom:14,padding:"12px 14px",background:sc.broke.length>0?"#1c0a0a":"#0f1a14",border:"1px solid "+(sc.broke.length>0?"#7f1d1d":"#166534"),borderRadius:8}}>
                  <div style={{fontSize:11,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:8}}>Commitment Review</div>
                  {sc.maxTrades!=null&&(
                    <div style={{fontSize:13,lineHeight:1.6,color:sc.overTrades?"#fca5a5":"#86efac",marginBottom:4}}>
                      {sc.overTrades?"✗ ":"✓ "}{sc.overTrades?("Took "+sc.actualTrades+" trades — over your "+sc.maxTrades+"-trade commitment"):("Stayed within your "+sc.maxTrades+"-trade cap ("+sc.actualTrades+" taken)")}
                    </div>
                  )}
                  {sc.setups&&(
                    <div style={{marginTop:8}}>
                      {/* CHANGED: Prefix with the commitment save time so the user sees WHEN they made this commitment. */}
                      <div style={{fontSize:12,color:"#94a3b8",marginBottom:6}}>{(function(){var ts=props.state.commitment&&props.state.commitment.committedAt;var t="";if(ts){try{t=new Date(ts).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}catch(e){}}return t?("At "+t+" you committed to: "):"You committed to: ";})()}<span style={{color:"#cbd5e1"}}>{sc.setups}</span></div>
                      <div style={{fontSize:12,color:"#94a3b8",marginBottom:6}}>Did you honor your commitment?</div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={function(){setAff(true);}} style={{flex:1,padding:"8px",background:aff===true?"#14532d":"#0a0a0f",border:"1px solid "+(aff===true?"#22c55e":"#1e293b"),borderRadius:6,color:aff===true?"#86efac":"#94a3b8",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Yes, stuck to plan</button>
                        <button onClick={function(){setAff(false);}} style={{flex:1,padding:"8px",background:aff===false?"#3a1010":"#0a0a0f",border:"1px solid "+(aff===false?"#ef4444":"#1e293b"),borderRadius:6,color:aff===false?"#fca5a5":"#94a3b8",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>No, I deviated</button>
                      </div>
                    </div>
                  )}
                  {sc.reviewed&&<div style={{fontSize:12,color:sc.adhered?"#86efac":"#fbbf24",marginTop:10,fontWeight:600,lineHeight:1.5}}>{sc.adhered?"You followed your own plan today. That's the win, regardless of P&L.":"You broke from your plan. Note why below — that reflection is how the plan gets better."}</div>}
                </div>
              );
            })()}
            <div style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase",marginBottom:6,fontWeight:600}}>Daily Note</div>
            <textarea value={entry.note||""} onChange={function(e){var v=e.target.value;var updated=Object.assign({},entry,{note:v});var dateKey=isToday?todayStr():selectedDate;try{localStorage.setItem("journal:"+dateKey.replace(/\//g,"-"),JSON.stringify(updated));}catch(err){}if(isToday){setTodayJournalEntry(updated);}else{setPastSessions(function(arr){return arr.map(function(x){return x.date===selectedDate?updated:x;});});}if(props.bumpReloadKey)props.bumpReloadKey();}} placeholder="What worked? What didn't? Any rules to remember tomorrow?" style={Object.assign({},fld,{minHeight:80,resize:"vertical",fontFamily:"inherit",lineHeight:1.5})}/>
            {/* CHANGED: Render the snapshot of economic events that matched the user's filters
               on this day. Helps re-read past sessions with the macro context they were traded in. */}
            {(function(){
              var ev=(entry.events||[]).slice().sort(function(a,b){return (a.ts||0)-(b.ts||0);});
              if(ev.length===0)return null;
              function impColor(imp){if(imp==="high")return "#ef4444";if(imp==="medium")return "#fbbf24";return "#64748b";}
              function fmtTime(ts){if(!ts)return "";var d=new Date(ts);var h=d.getHours();var m=d.getMinutes();var ap=h>=12?"PM":"AM";var hh=h%12||12;return hh+":"+String(m).padStart(2,"0")+" "+ap;}
              return (
                <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid #1e293b"}}>
                  <div style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:8}}>Economic Events · {ev.length}</div>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {ev.map(function(e,i){return (
                      <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12}}>
                        <span style={{width:6,height:6,borderRadius:"50%",background:impColor(e.impact),flexShrink:0}}/>
                        <span style={{color:"#94a3b8",fontVariantNumeric:"tabular-nums",minWidth:60}}>{fmtTime(e.ts)}</span>
                        <span style={{color:"#64748b",fontSize:10,fontWeight:700,letterSpacing:0.5}}>{e.currency||""}</span>
                        <span style={{color:"#e2e8f0",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.title||""}</span>
                      </div>
                    );})}
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}
      {/* Save Day to Journal removed — today's entry is now auto-saved (see App's auto-save effect). */}
        </React.Fragment>
      )}
      {/* CHANGED: Lightbox for No-Trade Day screenshots. */}
      {noTradeViewer&&(
        <div onClick={function(){setNoTradeViewer(null);}} style={{position:"fixed",inset:0,background:"#000000ee",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20,cursor:"pointer"}}>
          <img src={noTradeViewer} alt="Screenshot" style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain",borderRadius:6}}/>
        </div>
      )}
    </div>
  );
}
// CHANGED: Cancel discards changes; Save Changes commits.
function JournalTab(props){
  var settings=props.settings;
  var [entries,setEntries]=useState([]);
  var [selectedEntry,setSelectedEntry]=useState(null);
  // CHANGED: Universal-edit state. editDraft holds {note, trades} together.
  var [editing,setEditing]=useState(false);
  var [editDraft,setEditDraft]=useState(null);
  // While in universal-edit mode, editingTradeIdx tracks which trade is currently expanded for editing.
  var [editingTradeIdx,setEditingTradeIdx]=useState(null);
  var [confirmDelete,setConfirmDelete]=useState(null);
  // CHANGED: All hooks must be before any early returns (Rules of Hooks).
  var [journalSortBy,setJournalSortBy]=useState("date_desc");
  var [journalFilters,setJournalFilters]=useState({});
  var [journalSortOpen,setJournalSortOpen]=useState(false);
  var [journalFilterOpen,setJournalFilterOpen]=useState(false);
  var [journalCalOpen,setJournalCalOpen]=useState(false);
  var [journalDateFilter,setJournalDateFilter]=useState(null);
  function loadAll(){var rows=loadJournalRows();rows.sort(function(a,b){return new Date(b.date)-new Date(a.date);});setEntries(rows);}
  useEffect(function(){loadAll();},[props.reloadKey]);
  function deleteEntry(date){try{localStorage.removeItem("journal:"+date.replace(/\//g,"-"));}catch(e){}setSelectedEntry(null);loadAll();if(props.bumpReloadKey)props.bumpReloadKey();}
  function startEdit(entry){
    setEditing(true);
    // Deep clone trades into the draft so changes don't mutate selectedEntry until Save.
    var draftTrades=(entry.trades||[]).map(function(t){return Object.assign({},t,{entries:(t.entries||[]).map(function(x){return Object.assign({},x);}),exits:(t.exits||[]).map(function(x){return Object.assign({},x);})});});
    setEditDraft({note:entry.note||"",trades:draftTrades});
    setEditingTradeIdx(null);
  }
  function cancelEdit(){
    setEditing(false);
    setEditDraft(null);
    setEditingTradeIdx(null);
  }
  function saveAllEdits(){
    if(!selectedEntry||!editDraft)return;
    var fn=props.autoAddViolations||function(x){return x;};
    // CHANGED: Re-derive openedAt/closedAt from leg times (in case user edited leg timestamps).
    function deriveTimes(t){
      var ents=t.entries||[],exs=t.exits||[];
      var et=ents.map(function(e){return e.time;}).filter(function(x){return !!x;});
      var xt=exs.map(function(e){return e.time;}).filter(function(x){return !!x;});
      var openedAt=et.length>0?Math.min.apply(null,et):t.openedAt;
      var closedAt=t.status==="open"?null:(xt.length>0?Math.max.apply(null,xt):t.closedAt);
      return Object.assign({},t,{openedAt:openedAt,closedAt:closedAt});
    }
    var ut=(editDraft.trades||[]).map(function(t){return fn(deriveTimes(t),settings.positionMax);});
    // CHANGED: Journal edits a saved (historical) day — preserve its own riskMax and score
    // against it, so changing the current risk setting never silently rescores past days.
    var entryRiskMax=(selectedEntry.riskMax!=null&&parseFloat(selectedEntry.riskMax)>0)?parseFloat(selectedEntry.riskMax):(parseFloat(settings.riskMax)||0);
    var newEntry=Object.assign({},selectedEntry,{
      note:editDraft.note||"",
      trades:ut,
      wins:ut.filter(function(x){return parseFloat(x.pnl)>0;}).length,
      losses:ut.filter(function(x){return parseFloat(x.pnl)<0;}).length,
      pnl:ut.reduce(function(s,x){return s+(parseFloat(x.pnl)||0);},0),
      disciplineScore:calcDiscipline(ut,entryRiskMax,{commitment:selectedEntry.commitment||null}),
      riskMax:entryRiskMax
    });
    try{localStorage.setItem("journal:"+selectedEntry.date.replace(/\//g,"-"),JSON.stringify(newEntry));}catch(e){}
    setSelectedEntry(newEntry);
    setEntries(function(arr){return arr.map(function(e){return e.date===newEntry.date?newEntry:e;});});
    setEditing(false);
    setEditDraft(null);
    setEditingTradeIdx(null);
    if(props.bumpReloadKey)props.bumpReloadKey();
  }
  function deleteDraftTrade(idx){
    setEditDraft(function(d){if(!d)return d;var nt=(d.trades||[]).filter(function(_,i){return i!==idx;});return Object.assign({},d,{trades:nt});});
    if(editingTradeIdx===idx)setEditingTradeIdx(null);
  }
  function updateDraftTrade(idx,updated){
    setEditDraft(function(d){if(!d)return d;var nt=(d.trades||[]).map(function(t,i){return i===idx?updated:t;});return Object.assign({},d,{trades:nt});});
  }
  if(selectedEntry){
    // CHANGED: When editing, render from draft. Otherwise from saved entry.
    var viewEntry=editing&&editDraft?Object.assign({},selectedEntry,{trades:editDraft.trades,note:editDraft.note}):selectedEntry;
    var pnlVal=parseFloat(viewEntry.pnl)||0;
    var trades=viewEntry.trades||[];
    // Live recompute when editing
    if(editing){
      pnlVal=trades.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
    }
    var wins=trades.filter(function(t){return parseFloat(t.pnl)>0;}).length;
    var losses=trades.filter(function(t){return parseFloat(t.pnl)<0;}).length;
    var winRate=trades.length>0?Math.round((wins/trades.length)*100):0;
    var avgWin=wins>0?(trades.filter(function(t){return parseFloat(t.pnl)>0;}).reduce(function(s,t){return s+parseFloat(t.pnl);},0)/wins):0;
    var avgLoss=losses>0?Math.abs(trades.filter(function(t){return parseFloat(t.pnl)<0;}).reduce(function(s,t){return s+parseFloat(t.pnl);},0)/losses):0;
    var liveDiscipline=editing?calcDiscipline(trades,(selectedEntry.riskMax!=null&&parseFloat(selectedEntry.riskMax)>0)?parseFloat(selectedEntry.riskMax):(parseFloat(settings.riskMax)||0),{commitment:selectedEntry.commitment||null}):(selectedEntry.disciplineScore||0);
    // CHANGED: Day % = day P&L ÷ account balance at start of day (consistent across app).
    var sumPct=(function(){var sb=getAccountBalanceAtDate(selectedEntry.date);return sb>0?(pnlVal/sb*100):0;})();
    var winPcts=trades.filter(function(t){return parseFloat(t.pnl)>0;}).map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});
    var lossPcts=trades.filter(function(t){return parseFloat(t.pnl)<0;}).map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});
    var avgWinPct=winPcts.length>0?(winPcts.reduce(function(s,v){return s+v;},0)/winPcts.length):0;
    var avgLossPct=lossPcts.length>0?Math.abs(lossPcts.reduce(function(s,v){return s+v;},0)/lossPcts.length):0;
    function fmtPct(v,signed){var s=v>=0?"+":"-";return (signed?s:(v<0?"-":""))+Math.abs(v).toFixed(2)+"%";}
    return (
      <div style={{paddingTop:16}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
          <button onClick={function(){if(editing){if(!confirm("Discard unsaved changes?"))return;}setSelectedEntry(null);setEditing(false);setEditDraft(null);setEditingTradeIdx(null);}} style={{padding:"6px 12px",background:"none",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>← Back</button>
          <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0"}}>{selectedEntry.date}</div>
          {editing&&<span style={{fontSize:10,padding:"2px 7px",background:"#1e1b4b",border:"1px solid #4338ca",borderRadius:3,color:"#a5b4fc",fontWeight:700,letterSpacing:0.5}}>EDITING</span>}
        </div>
        <div style={CS({marginBottom:14})}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
            <div>
              <div style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Daily P&L</div>
              <div style={{fontSize:28,fontWeight:700,color:pnlVal>=0?"#22c55e":"#ef4444",marginTop:4}}>{HIDE_DOLLAR_PNL?fmtPct(sumPct,true):((pnlVal>=0?"+":"-")+"$"+Math.abs(pnlVal).toFixed(2))}</div>
            </div>
            <div style={{display:"flex",gap:8}}>
              {!editing&&<button onClick={function(){startEdit(selectedEntry);}} style={{padding:"5px 11px",background:"#1e1b4b",border:"1px solid #4338ca",borderRadius:6,color:"#a5b4fc",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Edit</button>}
              {!editing&&<button onClick={function(){setConfirmDelete(selectedEntry.date);}} style={{padding:"5px 11px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:6,color:"#fca5a5",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Delete entry</button>}
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
            <div style={{background:"#0a0a0f",borderRadius:8,padding:"8px 10px",border:"1px solid #1e293b"}}><div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Trades</div><div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",marginTop:2}}>{trades.length}</div></div>
            <div style={{background:"#0a0a0f",borderRadius:8,padding:"8px 10px",border:"1px solid #1e293b"}}><div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Win Rate</div><div style={{fontSize:18,fontWeight:700,color:wrColor(winRate),marginTop:2}}>{winRate}%</div></div>
            <div style={{background:"#0a0a0f",borderRadius:8,padding:"8px 10px",border:"1px solid #1e293b"}}><div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Discipline</div><div style={{fontSize:18,fontWeight:700,color:discColor(liveDiscipline),marginTop:2}}>{liveDiscipline}</div></div>
          </div>
          {trades.length>0&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div style={{background:"#0a0a0f",borderRadius:8,padding:"8px 10px",border:"1px solid #1e293b"}}><div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Avg Win</div><div style={{fontSize:15,fontWeight:700,color:"#22c55e",marginTop:2}}>{HIDE_DOLLAR_PNL?("+"+avgWinPct.toFixed(2)+"%"):"$"+avgWin.toFixed(2)}</div></div>
            <div style={{background:"#0a0a0f",borderRadius:8,padding:"8px 10px",border:"1px solid #1e293b"}}><div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Avg Loss</div><div style={{fontSize:15,fontWeight:700,color:"#ef4444",marginTop:2}}>{HIDE_DOLLAR_PNL?("-"+avgLossPct.toFixed(2)+"%"):"$"+avgLoss.toFixed(2)}</div></div>
          </div>}
        </div>
        <div style={CS({marginBottom:14})}>
          <div style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>Daily Note</div>
          {editing
            ?<textarea autoFocus value={editDraft.note} onChange={function(e){var v=e.target.value;setEditDraft(function(d){return Object.assign({},d,{note:v});});}} placeholder="What happened today? Lessons learned, observations, etc..." style={Object.assign({},fld,{minHeight:120,resize:"vertical",fontFamily:"inherit",lineHeight:1.5})}/>
            :(selectedEntry.note?<div style={{fontSize:14,color:"#cbd5e1",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{selectedEntry.note}</div>:<div style={{fontSize:13,color:"#64748b",fontStyle:"italic"}}>No note for this day. Click Edit to add one.</div>)
          }
        </div>
        {trades.length>0&&!editing&&<PnLChart trades={trades}/>}
        <div style={{marginTop:14,marginBottom:editing?80:0}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Trades</div>
            {editing&&<div style={{fontSize:11,color:"#475569"}}>Tap a trade to edit · × to remove</div>}
          </div>
          {/* CHANGED: 3 trade cards per row on laptop, single column on mobile. Editing card spans full width. */}
          <div style={{display:"grid",gridTemplateColumns:props.mobile?"1fr":"1fr 1fr 1fr",gap:12,alignItems:"stretch"}}>
          {trades.map(function(t,i){
            // CHANGED: Universal-edit mode — clicking a trade tile opens its inline editor.
            //          Per-trade Edit/Delete buttons are hidden (handled by hideControls in TradeTile).
            //          A small × per row in edit mode lets you delete the trade from the draft.
            //          Inline TradeForm is wrapped to commit changes back to editDraft.trades on its onSave.
            var isExpanded=editing&&editingTradeIdx===i;
            if(isExpanded){
              return (
                <div key={t.id||i} style={{gridColumn:"1 / -1"}}>
                <TradeForm
                  trade={t}
                  setTrade={function(updater){
                    setEditDraft(function(d){
                      if(!d)return d;
                      var current=d.trades[i];
                      var next=typeof updater==="function"?updater(current):updater;
                      var nt=d.trades.slice();nt[i]=next;
                      return Object.assign({},d,{trades:nt});
                    });
                  }}
                  onSave={function(updated){updateDraftTrade(i,updated);setEditingTradeIdx(null);}}
                  onCancel={function(){setEditingTradeIdx(null);}}
                  settings={settings}
                  tradeOptions={props.tradeOptions}
                />
                </div>
              );
            }
            return (
              <div key={t.id||i} style={{position:"relative"}}>
                {editing&&(
                  <div style={{position:"absolute",bottom:10,right:10,zIndex:5,display:"flex",gap:4}}>
                    <button onClick={function(){setEditingTradeIdx(i);}} style={{padding:"4px 11px",background:"#1e1b4b",border:"1px solid #4338ca",borderRadius:4,color:"#a5b4fc",fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>Edit</button>
                    <button onClick={function(){deleteDraftTrade(i);}} aria-label="Remove" style={{padding:"4px 9px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:4,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>
                  </div>
                )}
                <TradeTile t={t} i={i} posMax={settings.positionMax} hideControls={true}/>
              </div>
            );
          })}
          </div>
        </div>
        {/* CHANGED: Sticky action bar at bottom of edit mode for Cancel / Save Changes. */}
        {editing&&(
          <div style={{position:"sticky",bottom:60,marginTop:16,padding:"10px 12px",background:"#0a0a0f",border:"1px solid #4338ca",borderRadius:10,display:"flex",gap:8,boxShadow:"0 -4px 16px rgba(0,0,0,0.4)",zIndex:30}}>
            <button onClick={cancelEdit} style={{flex:1,padding:"10px",background:"none",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>Cancel</button>
            <button onClick={saveAllEdits} style={{flex:2,padding:"10px",background:"#4f46e5",border:"none",borderRadius:6,color:"#fff",fontSize:13,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Save Changes</button>
          </div>
        )}
        {confirmDelete&&(
          <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:20}} onClick={function(){setConfirmDelete(null);}}>
            <div onClick={function(e){e.stopPropagation();}} style={{background:"#111118",border:"1px solid #7f1d1d",borderRadius:12,padding:20,maxWidth:340,width:"100%"}}>
              <div style={{fontSize:16,fontWeight:700,color:"#fca5a5",marginBottom:8}}>Delete journal entry?</div>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:14,lineHeight:1.5}}>This will permanently remove the entry for {confirmDelete} including all trades and notes. This cannot be undone.</div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={function(){setConfirmDelete(null);}} style={{flex:1,padding:"9px",background:"none",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>Cancel</button>
                <button onClick={function(){deleteEntry(confirmDelete);setConfirmDelete(null);}} style={{flex:1,padding:"9px",background:"#7f1d1d",border:"1px solid #ef4444",borderRadius:6,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{paddingTop:16}}>
      <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",marginBottom:12}}>Journal</div>

      {/* CHANGED: Calendar picker + Sort + Filter row matching Trades tab. */}
      <div style={{position:"relative",marginBottom:12}}>
        <div style={{display:"flex",gap:8,marginBottom:6}}>
          <button onClick={function(){setJournalCalOpen(function(o){return !o;});setJournalSortOpen(false);setJournalFilterOpen(false);}} style={{flex:1,padding:"8px 12px",background:journalDateFilter?"#1e1b4b":"#111118",border:"1px solid "+(journalDateFilter?"#4338ca":"#334155"),borderRadius:6,color:journalDateFilter?"#a5b4fc":"#64748b",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>{journalDateFilter||"All Dates"}</span><span style={{fontSize:12}}>📅</span>
          </button>
          {journalDateFilter&&<button onClick={function(){setJournalDateFilter(null);}} style={{padding:"8px 10px",background:"transparent",border:"1px solid #334155",borderRadius:6,color:"#64748b",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>✕</button>}
        </div>
        {journalCalOpen&&(
          <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:400}}>
            <CalendarPicker selectedDate={journalDateFilter||todayStr()} onSelect={function(d){setJournalDateFilter(d);setJournalCalOpen(false);}} onClose={function(){setJournalCalOpen(false);}}/>
          </div>
        )}
        <div style={{display:"flex",gap:8}}>
          <div style={{position:"relative",flex:1}}>
            <button onClick={function(){setJournalSortOpen(function(o){return !o;});setJournalFilterOpen(false);}} style={{width:"100%",padding:"8px 12px",background:journalSortBy!=="date_desc"?"#1e1b4b":"#111118",border:"1px solid "+(journalSortBy!=="date_desc"?"#4338ca":"#334155"),borderRadius:6,color:journalSortBy!=="date_desc"?"#a5b4fc":"#64748b",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>Sort{journalSortBy!=="date_desc"?" ✓":""}</span><span style={{fontSize:12}}>▾</span>
            </button>
            {journalSortOpen&&(
              <div style={{position:"absolute",top:"100%",left:0,right:0,background:"#1e293b",border:"1px solid #334155",borderRadius:8,zIndex:300,overflow:"hidden",boxShadow:"0 8px 24px #00000088",marginTop:4}}>
                {[{id:"date_desc",label:"Newest First"},{id:"date_asc",label:"Oldest First"},{id:"pnl_pos",label:"P&L $ (Best First)"},{id:"pnl_neg",label:"P&L $ (Worst First)"},{id:"trades_desc",label:"Most Trades"},{id:"wr_desc",label:"Win Rate (High→Low)"}].map(function(opt){
                  return <button key={opt.id} onClick={function(){setJournalSortBy(opt.id);setJournalSortOpen(false);}} style={{width:"100%",padding:"10px 14px",background:journalSortBy===opt.id?"#1e1b4b":"transparent",border:"none",borderBottom:"1px solid #334155",color:journalSortBy===opt.id?"#a5b4fc":"#cbd5e1",fontSize:14,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>{opt.label}</button>;
                })}
              </div>
            )}
          </div>
          {(function(){
            var jFilterDefs=[{key:"result",label:"Result",options:["Green","Red"]},{key:"grade",label:"Has Grade",options:["A","B","C"]}];
            var activeCount=Object.values(journalFilters).filter(function(v){return v&&v.length>0;}).length;
            return (
              <div style={{position:"relative",flex:1}}>
                <button onClick={function(){setJournalFilterOpen(function(o){return !o;});setJournalSortOpen(false);}} style={{width:"100%",padding:"8px 12px",background:activeCount>0?"#1e1b4b":"#111118",border:"1px solid "+(activeCount>0?"#4338ca":"#334155"),borderRadius:6,color:activeCount>0?"#a5b4fc":"#64748b",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span>Filter{activeCount>0?" ("+activeCount+")":""}</span><span style={{fontSize:12}}>▾</span>
                </button>
                {journalFilterOpen&&(
                  <div style={{position:"absolute",top:"100%",right:0,left:0,background:"#1e293b",border:"1px solid #334155",borderRadius:8,zIndex:300,boxShadow:"0 8px 24px #00000088",marginTop:4,padding:"10px 12px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                      <span style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>Filters</span>
                      {activeCount>0&&<button onClick={function(){setJournalFilters({});}} style={{background:"none",border:"none",color:"#f87171",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Clear all</button>}
                    </div>
                    {jFilterDefs.map(function(fd){
                      var selected=journalFilters[fd.key]||[];
                      return (
                        <div key={fd.key} style={{marginBottom:10}}>
                          <div style={{fontSize:12,color:"#6366f1",letterSpacing:1,textTransform:"uppercase",marginBottom:6,fontWeight:600}}>{fd.label}</div>
                          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                            {fd.options.map(function(opt){var active=selected.indexOf(opt)>=0;return <button key={opt} onClick={function(){setJournalFilters(function(f){var cur=f[fd.key]||[];var next=active?cur.filter(function(x){return x!==opt;}):[].concat(cur,[opt]);return Object.assign({},f,{[fd.key]:next});});}} style={{padding:"4px 10px",background:active?"#4f46e5":"#0a0a0f",border:"1px solid "+(active?"#6366f1":"#334155"),borderRadius:4,color:active?"#fff":"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{opt}</button>;})}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {(function(){
        var filtered=entries.filter(function(entry){
          if(journalDateFilter&&entry.date!==journalDateFilter)return false;
          var pnl=parseFloat(entry.pnl)||0;
          var res=journalFilters.result||[];
          if(res.length===1){if(res[0]==="Green"&&pnl<0)return false;if(res[0]==="Red"&&pnl>=0)return false;}
          var gc=journalFilters.grade||[];
          if(gc.length>0){var trades=entry.trades||[];var hasGrade=gc.some(function(g){return trades.some(function(t){return t.grade===g;});});if(!hasGrade)return false;}
          return true;
        });
        if(journalSortBy==="date_asc")filtered=filtered.slice().sort(function(a,b){return new Date(a.date)-new Date(b.date);});
        else if(journalSortBy==="pnl_pos")filtered=filtered.slice().sort(function(a,b){return (parseFloat(b.pnl)||0)-(parseFloat(a.pnl)||0);});
        else if(journalSortBy==="pnl_neg")filtered=filtered.slice().sort(function(a,b){return (parseFloat(a.pnl)||0)-(parseFloat(b.pnl)||0);});
        else if(journalSortBy==="trades_desc")filtered=filtered.slice().sort(function(a,b){return (b.trades||[]).length-(a.trades||[]).length;});
        else if(journalSortBy==="wr_desc")filtered=filtered.slice().sort(function(a,b){var wa=(a.wins||0)/Math.max(1,(a.trades||[]).length),wb=(b.wins||0)/Math.max(1,(b.trades||[]).length);return wb-wa;});
        if(entries.length===0)return <div style={{textAlign:"center",padding:"40px 20px",borderTop:"1px dashed #1e293b",marginTop:8}}><div style={{fontSize:14,color:"#475569"}}>No journal entries yet</div><div style={{fontSize:12,color:"#64748b",marginTop:4}}>Save your first session to start your journal</div></div>;
        if(filtered.length===0)return <div style={{textAlign:"center",padding:"32px 20px",color:"#475569"}}><div style={{fontSize:14}}>No entries match</div></div>;
        return filtered.map(function(entry){
          var pnl=parseFloat(entry.pnl)||0;
          var trades=entry.trades||[];
          var wins=trades.filter(function(t){return parseFloat(t.pnl)>0;}).length;
          var losses=trades.filter(function(t){return parseFloat(t.pnl)<0;}).length;
          var breakevens=trades.filter(function(t){return Math.abs(parseFloat(t.pnl)||0)<0.01;}).length;
          var winRate=trades.length>0?Math.round((wins/trades.length)*100):0;
          var sumPct=(function(){var sb=getAccountBalanceAtDate(entry.date);return sb>0?(pnl/sb*100):0;})();
          return (
            <button key={entry.date} onClick={function(){setSelectedEntry(entry);}} style={{width:"100%",display:"block",textAlign:"left",background:"#111118",border:"1px solid #1e293b",borderLeft:"3px solid "+(pnl>=0?"#22c55e44":"#ef444444"),borderRadius:10,padding:"12px 14px",marginBottom:8,cursor:"pointer",fontFamily:"inherit"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{entry.date}</div>
                  <div style={{fontSize:12,color:"#64748b"}}>{trades.length} trade{trades.length===1?"":"s"} · {winRate}% WR{breakevens>0?" · "+breakevens+" BE":""} · D{entry.disciplineScore||0}</div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontSize:16,fontWeight:700,color:pnl>=0?"#22c55e":"#ef4444"}}>{HIDE_DOLLAR_PNL?((sumPct>=0?"+":"")+sumPct.toFixed(2)+"%"):((pnl>=0?"+":"-")+"$"+Math.abs(pnl).toFixed(2))}</div>
                </div>
              </div>
              {entry.note&&<div style={{fontSize:12,color:"#94a3b8",marginTop:5,fontStyle:"italic",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>"{entry.note}"</div>}
            </button>
          );
        });
      })()}
    </div>
  );
}

function GoalCard2(props){
  var gp=props;
  var [showInfo,setShowInfo]=useState(false);
  var tgt=gp.target||0;
  var isPercent=gp.wrColor||gp.discColor;
  var pct=isPercent?Math.min(gp.value,100):(tgt>0?Math.min(gp.value/tgt*100,100):0);
  var over=tgt>0&&gp.value>=tgt;
  var markerPct=isPercent&&tgt>0?Math.min(tgt,100):null;
  var barColor=isPercent?(tgt>0?(gp.value>=tgt?"#22c55e":"#ef4444"):"#f59e0b"):(gp.value>0?"#22c55e":gp.value<0?"#ef4444":"#94a3b8");
  var dec=gp.decimals!=null?gp.decimals:2;
  var tdec=gp.targetDecimals!=null?gp.targetDecimals:dec;
  var color;
  if(isPercent){color=tgt>0?(gp.value>=tgt?"#22c55e":"#ef4444"):"#94a3b8";}
  else {color=gp.value>0?"#22c55e":gp.value<0?"#ef4444":"#94a3b8";}
  var prefix=gp.prefix||"";
  var fv;
  if(gp.formatValue)fv=gp.formatValue(gp.value);
  else fv=(gp.value<0?"-":"")+prefix+Math.abs(gp.value).toFixed(dec)+(gp.suffix||"");
  var ft=tgt>0?(prefix+(typeof tgt==="number"?tgt.toFixed(tdec):tgt)+(gp.suffix||"")):"Not set";
  var showBar=tgt>0||isPercent;
  // CHANGED: When a goal that opts into completion (account balance, week P&L, month P&L) reaches its
  // target, show a distinct "completed" treatment — green border, badge, and green title.
  var completed=!!gp.markComplete&&over;
  return (
    <div style={CS({marginBottom:12,position:"relative",border:completed?"1px solid #22c55e":undefined,background:completed?"#0f1f15":undefined})}>
      {completed&&<div style={{position:"absolute",top:8,right:gp.onHide||gp.onDelete?32:8,fontSize:10,fontWeight:800,color:"#052e16",background:"#22c55e",borderRadius:4,padding:"2px 7px",letterSpacing:0.5}}>✓ COMPLETED</div>}
      {gp.onHide&&(
        <button onClick={function(e){e.stopPropagation();gp.onHide();}} aria-label={"Hide "+gp.label} title={"Hide "+gp.label} style={{position:"absolute",top:8,right:8,width:20,height:20,padding:0,background:"none",border:"none",color:"#475569",fontSize:14,cursor:"pointer",fontFamily:"inherit",lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:3}}>×</button>
      )}
      {gp.onDelete&&(
        <button onClick={function(e){e.stopPropagation();gp.onDelete();}} aria-label={"Delete "+gp.label} title={"Delete "+gp.label} style={{position:"absolute",top:8,right:8,padding:"3px 8px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:4,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>
      )}
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,paddingRight:gp.onHide||gp.onDelete?22:0}}>
        <div style={{fontSize:12,color:completed?"#86efac":"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:completed?700:400}}>{gp.label}</div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:4}}>
        <div style={{fontSize:25,fontWeight:700,color:color,flexShrink:0}}>{fv}</div>
        {showBar&&(
          <div style={{flex:1,minWidth:0}}>
            <div style={{position:"relative",height:6,background:"#1e293b",borderRadius:3}}>
              <div style={{height:"100%",width:pct+"%",background:barColor,borderRadius:3,transition:"width 0.4s",position:"absolute",top:0,left:0}}/>
              {markerPct!==null&&<div title={"Target: "+tgt+"%"} style={{position:"absolute",top:-2,left:markerPct+"%",transform:"translateX(-50%)",width:2,height:10,background:"#f8fafc",borderRadius:1,boxShadow:"0 0 0 1px #0a0a0f"}}/>}
            </div>
            <div style={{fontSize:11,color:over?"#86efac":"#64748b",marginTop:3,textAlign:"right"}}>{over?"✓ Goal reached":isPercent?(tgt>0?pct.toFixed(0)+"% · target "+tgt+"%":pct.toFixed(0)+"%"):pct.toFixed(0)+"% of target"}</div>
          </div>
        )}
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:2}}>Target</div>
          <div style={{fontSize:16,fontWeight:600,color:over?"#22c55e":"#94a3b8"}}>{ft}</div>
        </div>
      </div>
      {/* CHANGED: optional subtext line (e.g. "This week: 82%"). */}
      {gp.subtext&&<div style={{fontSize:11,color:"#64748b",marginTop:4}}>{gp.subtext}</div>}
      {/* CHANGED: Deadline display with days-remaining indicator. */}
      {gp.deadline&&(function(){
        var dl=new Date(gp.deadline+"T00:00:00");
        var diffDays=Math.ceil((dl-new Date())/(1000*60*60*24));
        var dlColor=diffDays<0?"#fca5a5":diffDays<=7?"#fbbf24":"#64748b";
        var dlText=diffDays<0?"Overdue by "+Math.abs(diffDays)+"d":diffDays===0?"Due today":diffDays===1?"Due tomorrow":"Due in "+diffDays+"d";
        return <div style={{fontSize:11,color:dlColor,marginTop:4,fontWeight:diffDays<=0?700:400}}>🗓 {gp.deadline} · {dlText}</div>;
      })()}
    </div>
  );
}

// CHANGED: Ring-based goal tile — a more aesthetic, dashboard-style alternative to the horizontal
// bar card. Same data/props as GoalCard2; renders a circular progress ring with the value centered,
// target below, and a completed state. Designed to sit in a responsive grid.
function GoalRing(props){
  var gp=props;
  var tgt=gp.target||0;
  var isPercent=gp.wrColor||gp.discColor;
  var pct=isPercent?Math.min(Math.max(gp.value,0),100):(tgt>0?Math.min(Math.max(gp.value/tgt*100,0),100):0);
  var over=tgt>0&&gp.value>=tgt;
  var dec=gp.decimals!=null?gp.decimals:2;
  var tdec=gp.targetDecimals!=null?gp.targetDecimals:dec;
  var prefix=gp.prefix||"";
  var fv=gp.formatValue?gp.formatValue(gp.value):((gp.value<0?"-":"")+prefix+Math.abs(gp.value).toFixed(dec)+(gp.suffix||""));
  var ft=gp.formatTarget?gp.formatTarget(tgt):(tgt>0?(prefix+(typeof tgt==="number"?tgt.toFixed(tdec):tgt)+(gp.suffix||"")):"Not set");
  var completed=!!gp.markComplete&&over;
  // ring color graduates with progress; completed = solid green.
  var ringColor=completed?"#22c55e":isPercent?(over?"#22c55e":pct>=70?"#84cc16":pct>=40?"#f59e0b":"#ef4444"):(gp.value<0?"#ef4444":pct>=70?"#22c55e":pct>=40?"#84cc16":"#6366f1");
  var valColor=gp.value<0?"#ef4444":completed?"#86efac":"#e2e8f0";
  // CHANGED: compact mode for tight columns (e.g. Home snapshot).
  var cmp=!!gp.compact;
  var SZ=cmp?56:84,R=cmp?22:34,SW=cmp?5:7,C=2*Math.PI*R,dash=C*pct/100;
  // CHANGED: for % goals (win rate, discipline) show the user's target as a tick marker on the
  // ring (at target% around the 0–100 track) instead of a text readout below.
  var showTargetMarker=isPercent&&tgt>0&&tgt<=100;
  var markerEl=null;
  if(showTargetMarker){
    var ang=(tgt/100)*2*Math.PI; // 0 at 3 o'clock; the <svg> is rotated -90° so 0 sits at top
    var cxp=SZ/2,cyp=SZ/2;
    var r1=R-SW/2-1,r2=R+SW/2+1;
    var mx1=cxp+r1*Math.cos(ang),my1=cyp+r1*Math.sin(ang);
    var mx2=cxp+r2*Math.cos(ang),my2=cyp+r2*Math.sin(ang);
    markerEl=<line x1={mx1} y1={my1} x2={mx2} y2={my2} stroke={over?"#22c55e":"#e2e8f0"} strokeWidth={cmp?1.5:2} strokeLinecap="round"/>;
  }
  return (
    <div style={CS({marginBottom:0,position:"relative",border:completed?"1px solid #22c55e44":"1px solid #1e293b",background:completed?"#0f1f15":"#0d0d12",display:"flex",flexDirection:"column",alignItems:"center",padding:cmp?"10px 8px":"16px 14px 14px",height:"100%",boxSizing:"border-box"})}>
      {gp.onHide&&<button onClick={function(e){e.stopPropagation();gp.onHide();}} aria-label={"Hide "+gp.label} title={"Hide "+gp.label} style={{position:"absolute",top:8,right:8,width:20,height:20,padding:0,background:"none",border:"none",color:"#475569",fontSize:14,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>}
      {gp.onDelete&&<button onClick={function(e){e.stopPropagation();gp.onDelete();}} aria-label={"Delete "+gp.label} title={"Delete "+gp.label} style={{position:"absolute",top:8,right:8,width:20,height:20,padding:0,background:"none",border:"none",color:"#475569",fontSize:14,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>}
      <div style={{fontSize:cmp?9:11,color:completed?"#86efac":"#64748b",letterSpacing:cmp?0.5:1,textTransform:"uppercase",fontWeight:completed?700:600,marginBottom:cmp?7:12,textAlign:"center",paddingRight:gp.onHide||gp.onDelete?14:0,lineHeight:1.2}}>{gp.label}</div>
      <div style={{position:"relative",width:SZ,height:SZ,marginBottom:cmp?6:10}}>
        <svg width={SZ} height={SZ} viewBox={"0 0 "+SZ+" "+SZ} style={{transform:"rotate(-90deg)"}}>
          <circle cx={SZ/2} cy={SZ/2} r={R} fill="none" stroke="#1e293b" strokeWidth={SW}/>
          <circle cx={SZ/2} cy={SZ/2} r={R} fill="none" stroke={ringColor} strokeWidth={SW} strokeLinecap="round" strokeDasharray={dash+" "+C} style={{transition:"stroke-dasharray 0.5s ease"}}/>
          {markerEl}
        </svg>
        <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
          {completed?<span style={{fontSize:cmp?15:22,color:"#22c55e"}}>✓</span>:<span style={{fontSize:cmp?12:17,fontWeight:800,color:ringColor,fontVariantNumeric:"tabular-nums"}}>{Math.round(pct)}<span style={{fontSize:cmp?7:9}}>%</span></span>}
        </div>
      </div>
      {/* CHANGED: % goals show target as a ring marker (with a tiny target legend) instead of a readout.
          $/R goals show the value readout when dollars are visible; nothing when hidden. */}
      {isPercent?(
        over?<div style={{fontSize:cmp?9:11,color:"#86efac",marginTop:1,textAlign:"center",fontWeight:700}}>Goal reached</div>
        :(HIDE_DOLLAR_PNL?null:<div style={{fontSize:cmp?8:10,color:"#475569",marginTop:1,textAlign:"center"}}>target {(typeof tgt==="number"?Math.round(tgt):tgt)}%</div>)
      ):HIDE_DOLLAR_PNL?(
        over&&<div style={{fontSize:cmp?9:11,color:"#86efac",marginTop:1,textAlign:"center",fontWeight:700}}>Goal reached</div>
      ):(<>
        <div style={{fontSize:cmp?15:21,fontWeight:800,color:valColor,fontVariantNumeric:"tabular-nums",lineHeight:1.1,textAlign:"center"}}>{fv}</div>
        <div style={{fontSize:cmp?9:11,color:"#64748b",marginTop:3,textAlign:"center"}}>{over?"Goal reached":"of "+ft}</div>
      </>)}
      {!cmp&&gp.subtext&&<div style={{fontSize:10,color:"#475569",marginTop:7,textAlign:"center",lineHeight:1.4,borderTop:"1px solid #1e293b",paddingTop:7,width:"100%"}}>{gp.subtext}</div>}
      {gp.deadline&&(function(){
        var dl=new Date(gp.deadline+"T00:00:00");
        var diffDays=Math.ceil((dl-new Date())/(1000*60*60*24));
        var dlColor=diffDays<0?"#fca5a5":diffDays<=7?"#fbbf24":"#64748b";
        var dlText=diffDays<0?"Overdue "+Math.abs(diffDays)+"d":diffDays===0?"Due today":diffDays===1?"Due tomorrow":diffDays+"d left";
        return <div style={{fontSize:10,color:dlColor,marginTop:6,fontWeight:diffDays<=0?700:500}}>🗓 {dlText}</div>;
      })()}
    </div>
  );
}

function GoalsTab(props){
  var settings=props.settings,liveTotalPnL=props.liveTotalPnL||0;
  var EMPTY_GOALS={weeklyMultiplier:"4",monthlyPnL:"",winRate:"",disciplineScore:"",accountTarget:"",withdrawals:"",custom:[],hidden:{}};
  // Defensive load that handles legacy or new formats and arrays
  function normalizeStored(p){
    if(!p)return Object.assign({},EMPTY_GOALS);
    // If it's an array, convert to custom-only schema
    if(Array.isArray(p))return Object.assign({},EMPTY_GOALS,{custom:p});
    if(typeof p!=="object")return Object.assign({},EMPTY_GOALS);
    // Ensure all expected fields exist
    return Object.assign({},EMPTY_GOALS,p,{
      custom:Array.isArray(p.custom)?p.custom:[],
      hidden:(p.hidden&&typeof p.hidden==="object")?p.hidden:{}
    });
  }
  var [goals,setGoals]=useState(EMPTY_GOALS);
  var [editing,setEditing]=useState(false);
  var [draft,setDraft]=useState(EMPTY_GOALS);
  var [showAdd,setShowAdd]=useState(false);
  // CHANGED: Custom-goal editing state.
  var [editingCustomId,setEditingCustomId]=useState(null);
  var [customDraft,setCustomDraft]=useState(null);
  // CHANGED: Two-step inline delete (avoids confirm() which can fail silently on mobile).
  var [confirmingDeleteId,setConfirmingDeleteId]=useState(null);
  // CHANGED: Default prefix/suffix per metric type (no "$" on non-dollar metrics).
  function defaultPrefixForMetric(m){if(m==="pnl"||m==="balance")return "$";return "";}
  function defaultSuffixForMetric(m){if(m==="winrate")return "%";if(m==="trades")return "";return "";}
  var [newGoal,setNewGoal]=useState({title:"",target:"",metric:"pnl",period:"daily",prefix:"$",suffix:"",customName:"",deadline:"",filterField:"",filterValue:""});

  useEffect(function(){
    try{var s=localStorage.getItem(GOALS_KEY);if(s)setGoals(normalizeStored(JSON.parse(s)));}catch(e){}
  },[]);

  function persist(g){try{localStorage.setItem(GOALS_KEY,JSON.stringify(g));}catch(e){}setGoals(g);}
  function saveStandardGoals(){persist(normalizeStored(draft));setEditing(false);}

  // CHANGED: validation for save button
  var canSaveCustom=newGoal.title.trim().length>0
    &&newGoal.target!==""&&!isNaN(parseFloat(newGoal.target))
    &&(newGoal.metric!=="custom"||newGoal.customName.trim().length>0);

  function addCustom(){
    if(!canSaveCustom)return;
    // CHANGED: Resolve section: "performance"/"pnl"/"account" go into the matching default section,
    // "newCustom" creates a named custom section (needs a name), "existing:NAME" re-uses one, else "custom".
    var section="custom",sectionName=null;
    if(newGoal.section==="performance"||newGoal.section==="pnl"||newGoal.section==="account")section=newGoal.section;
    else if(newGoal.section==="newCustom"&&(newGoal.sectionName||"").trim()){section="namedCustom";sectionName=newGoal.sectionName.trim();}
    else if((newGoal.section||"").indexOf("existing:")===0){section="namedCustom";sectionName=newGoal.section.slice(9);}
    var g={
      id:Date.now(),
      title:newGoal.title.trim(),
      target:newGoal.target,
      metric:newGoal.metric,
      period:newGoal.period,
      prefix:newGoal.prefix,
      suffix:newGoal.suffix,
      deadline:newGoal.deadline||null,
      customName:newGoal.metric==="custom"?newGoal.customName.trim():null,
      customValue:newGoal.metric==="custom"?"0":null,
      filterField:newGoal.filterField||"",
      filterValue:newGoal.filterValue||"",
      section:section,
      sectionName:sectionName
    };
    var updated=normalizeStored(Object.assign({},goals,{custom:[].concat(goals.custom||[],[g])}));
    persist(updated);
    setNewGoal({title:"",target:"",metric:"pnl",period:"daily",prefix:defaultPrefixForMetric("pnl"),suffix:defaultSuffixForMetric("pnl"),customName:"",deadline:"",filterField:"",filterValue:"",section:"custom",sectionName:""});
    setShowAdd(false);
  }
  function delCustom(id){
    // CHANGED: Use latest goals from setState callback to avoid stale-closure bugs.
    setGoals(function(prev){
      var updated=normalizeStored(Object.assign({},prev,{custom:(prev.custom||[]).filter(function(g){return g.id!==id;})}));
      try{localStorage.setItem(GOALS_KEY,JSON.stringify(updated));}catch(e){}
      return updated;
    });
  }
  function updateCustom(id,patch){
    setGoals(function(prev){
      var updated=normalizeStored(Object.assign({},prev,{custom:(prev.custom||[]).map(function(g){return g.id===id?Object.assign({},g,patch):g;})}));
      try{localStorage.setItem(GOALS_KEY,JSON.stringify(updated));}catch(e){}
      return updated;
    });
  }
  function hide(key){persist(normalizeStored(Object.assign({},goals,{hidden:Object.assign({},goals.hidden||{},{[key]:true})})));}
  function unhide(key){var h=Object.assign({},goals.hidden||{});delete h[key];persist(normalizeStored(Object.assign({},goals,{hidden:h})));}

  var rows=loadJournalRows();
  var now=getPT(),y=now.getFullYear(),m=now.getMonth(),d=now.getDate(),day=now.getDay();
  var today=todayStr();
  var todayJournal=rows.find(function(e){return e.date===today;});
  var todayPnL=todayJournal?(parseFloat(todayJournal.pnl)||0):liveTotalPnL;
  var livePnL=todayJournal?0:liveTotalPnL;

  // CHANGED: Sun-Sat week boundaries to match the rest of the app.
  var wkStart=new Date(y,m,d-day);
  var wkEnd=new Date(wkStart);wkEnd.setDate(wkStart.getDate()+6);
  var moStart=new Date(y,m,1);

  var weekPnL=rows.filter(function(e){var dd=new Date(e.date);return dd>=wkStart&&dd<=wkEnd;}).reduce(function(s,e){return s+(parseFloat(e.pnl)||0);},0)+livePnL;
  var monthPnL=rows.filter(function(e){return new Date(e.date)>=moStart;}).reduce(function(s,e){return s+(parseFloat(e.pnl)||0);},0)+livePnL;
  var dailyPnL=todayPnL;

  var allT=rows.reduce(function(a,e){return a.concat(e.trades||[]);},[]);
  var allW=allT.filter(function(t){return parseFloat(t.pnl)>0;});
  var oWR=allT.length>0?allW.length/allT.length*100:0;
  var aDisc=rows.length>0?rows.reduce(function(s,e){return s+calcDiscipline(e.trades||[],e.riskMax,{commitment:e.commitment||null});},0)/rows.length:0;
  // CHANGED: This-week discipline avg, computed identically to the weekly challenge (Sunday-based,
  // days with trades only) so the two figures line up.
  var discWeekStart=getWeekStart();
  var discWeekDays=rows.filter(function(e){return new Date(e.date)>=discWeekStart&&(e.trades||[]).length>0;});
  var aDiscWeek=discWeekDays.length>0?discWeekDays.reduce(function(s,e){return s+calcDiscipline(e.trades||[],e.riskMax,{commitment:e.commitment||null});},0)/discWeekDays.length:0;
  // CHANGED: This-week win rate (same Sunday-based week start), so Goals can show weekly vs all-time.
  var weekTrades=rows.filter(function(e){return new Date(e.date)>=discWeekStart;}).reduce(function(a,e){return a.concat(e.trades||[]);},[]);
  var weekWins=weekTrades.filter(function(t){return parseFloat(t.pnl)>0;}).length;
  var wWR=weekTrades.length>0?weekWins/weekTrades.length*100:0;

  var autoDaily=computeDailyTarget(settings);
  var dailyTarget=autoDaily;
  // CHANGED: when $ is hidden, P&L goal cards display in R (value ÷ risk-per-trade).
  var gtRiskMax=parseFloat(settings.riskMax)||0;
  function gtRFmt(v){var r=gtRiskMax>0?v/gtRiskMax:0;return (r>=0?"+":"")+r.toFixed(1)+"R";}
  var pnlFmt=HIDE_DOLLAR_PNL?{formatValue:gtRFmt,formatTarget:gtRFmt}:{};
  var weeklyMultiplier=parseFloat(goals.weeklyMultiplier)||4;
  var weeklyTarget=autoDaily*weeklyMultiplier;
  var monthlyTarget=parseFloat(goals.monthlyPnL)||0;
  var winRateTarget=parseFloat(goals.winRate)||0;
  // CHANGED: Discipline Score goal is tied directly to the discipline LOCK THRESHOLD setting and
  // is no longer user-editable in Goals. The goal is simply: keep your score above the lock bar.
  var disciplineTarget=loadDisciplineLockThreshold();
  var accountTarget=parseFloat(goals.accountTarget)||0;
  var withdrawalTarget=parseFloat(goals.withdrawals)||0;
  var totalWithdrawn=getTotalWithdrawn();

  var transferTotalVal=transferTotal(loadTransfers());
  var totalAllPnL=rows.reduce(function(s,e){return s+(parseFloat(e.pnl)||0);},0)+liveTotalPnL;
  // CHANGED: Use canonical balance helper to avoid double-counting today's live P&L if already saved to journal.
  var currentAccount=computeAccountBalance(liveTotalPnL);

  // CHANGED: Filter trades by a form field (setup, grade, etc). Indicators/emotions/violations are arrays.
  function matchesFilter(trade,field,value){
    if(!field||!value)return true;
    var v=trade[field];
    if(Array.isArray(v))return v.indexOf(value)>=0;
    return v===value;
  }
  function getTradesForPeriod(period){
    if(period==="daily"){
      var todayE=rows.find(function(e){return e.date===today;});
      var t=todayE?(todayE.trades||[]):[];
      if(!todayE&&props.state)t=(props.state.trades||[]).filter(function(x){return x.status!=="open";});
      return t;
    }
    if(period==="weekly")return rows.filter(function(e){var dd=new Date(e.date);return dd>=wkStart&&dd<=wkEnd;}).reduce(function(a,e){return a.concat(e.trades||[]);},[]);
    if(period==="monthly")return rows.filter(function(e){return new Date(e.date)>=moStart;}).reduce(function(a,e){return a.concat(e.trades||[]);},[]);
    return allT;
  }
  function getCustomVal(g){
    if(g.metric==="custom")return parseFloat(g.customValue||0)||0;
    // CHANGED: For filtered goals or option-based metrics, work from per-trade arrays.
    var hasFilter=g.filterField&&g.filterValue;
    var optionMetrics=["pnl_filtered","trades_filtered","winrate_filtered","count_grade","count_setup","count_indicator","count_emotion","count_violation"];
    if(hasFilter||optionMetrics.indexOf(g.metric)>=0){
      var trades=getTradesForPeriod(g.period||"all");
      if(hasFilter)trades=trades.filter(function(t){return matchesFilter(t,g.filterField,g.filterValue);});
      if(g.metric==="pnl"||g.metric==="pnl_filtered")return trades.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
      if(g.metric==="trades"||g.metric==="trades_filtered")return trades.length;
      if(g.metric==="winrate"||g.metric==="winrate_filtered"){var w=trades.filter(function(t){return parseFloat(t.pnl)>0;}).length;return trades.length>0?parseFloat((w/trades.length*100).toFixed(1)):0;}
      return trades.length;
    }
    if(g.metric==="pnl"){
      if(g.period==="daily")return dailyPnL;
      if(g.period==="weekly")return weekPnL;
      if(g.period==="monthly")return monthPnL;
      return totalAllPnL;
    }
    if(g.metric==="winrate")return parseFloat(oWR.toFixed(1));
    if(g.metric==="discipline")return parseFloat(aDisc.toFixed(0));
    if(g.metric==="trades"){
      if(g.period==="daily")return props.state?(props.state.trades||[]).length:0;
      if(g.period==="weekly")return rows.filter(function(e){var dd=new Date(e.date);return dd>=wkStart&&dd<=wkEnd;}).reduce(function(s,e){return s+(e.trades||[]).length;},0);
      if(g.period==="monthly")return rows.filter(function(e){return new Date(e.date)>=moStart;}).reduce(function(s,e){return s+(e.trades||[]).length;},0);
      return rows.reduce(function(s,e){return s+((e.trades||[]).length);},0);
    }
    if(g.metric==="balance")return currentAccount;
    return 0;
  }

  if(editing){
    return (
      <div style={{paddingTop:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0"}}>Edit Goals</div>
          <button onClick={function(){setEditing(false);}} style={{background:"none",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:14,cursor:"pointer",fontFamily:"inherit",padding:"6px 14px"}}>Cancel</button>
        </div>
        <div style={{padding:"10px 12px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:8,marginBottom:12,fontSize:13,color:"#94a3b8",lineHeight:1.5}}>Daily P&L target is auto-calculated from each enabled session's position size and gain hard stop: <span style={{color:"#22c55e",fontWeight:700}}>${Math.round(autoDaily)}</span> (one winning trade per session at its gain stop, sized by risk max ${(parseFloat(settings.riskMax)||0)}). Adjust sessions and gain stops in Settings.</div>
        {[{key:"weeklyMultiplier",label:"Weekly P&L Multiplier (× Daily Target)",ph:"e.g. 4"},{key:"monthlyPnL",label:"Monthly P&L Target ($)",ph:"e.g. 3000"},{key:"winRate",label:"Win Rate Target (%)",ph:"e.g. 60"},{key:"accountTarget",label:"Account Milestone ($)",ph:"e.g. 5000"},{key:"withdrawals",label:"Total Withdrawn Target ($)",ph:"e.g. 10000"}].map(function(f){
          return <div key={f.key} style={{marginBottom:12}}><label style={lbl}>{f.label}</label><input type="number" value={draft[f.key]||""} onChange={function(e){var v=e.target.value;setDraft(function(g){return Object.assign({},g,{[f.key]:v});});}} placeholder={f.ph} style={fld}/></div>;
        })}
        <button onClick={saveStandardGoals} style={{width:"100%",padding:"13px",background:"linear-gradient(135deg,#4f46e5,#6366f1)",color:"#fff",border:"none",borderRadius:10,fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginTop:4}}>Save Goals</button>
        {/* CHANGED: Custom goals editing lives here (was a per-card Edit button before). Click any to open its inline edit form. */}
        {(goals.custom||[]).length>0&&(
          <div style={{marginTop:24,paddingTop:16,borderTop:"1px solid #1e293b"}}>
            <div style={{fontSize:12,color:"#94a3b8",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700,marginBottom:10}}>Custom Goals</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax("+(props.mobile?"140px":"190px")+",1fr))",gap:props.mobile?8:12,alignItems:"stretch"}}>
              {(goals.custom||[]).map(function(cg){
                if(editingCustomId===cg.id)return renderCustomGoal(cg);
                return (
                  <button key={cg.id} onClick={function(){setEditingCustomId(cg.id);setCustomDraft({title:cg.title||"",target:cg.target||"",metric:cg.metric||"pnl",period:cg.period||"daily",prefix:cg.prefix||"",suffix:cg.suffix||"",customName:cg.customName||"",deadline:cg.deadline||"",filterField:cg.filterField||"",filterValue:cg.filterValue||""});}} style={{textAlign:"left",padding:"10px 12px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:8,cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",gap:3}}>
                    <div style={{fontSize:12,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cg.title}</div>
                    <div style={{fontSize:10,color:"#64748b"}}>{cg.metric}{cg.period?" · "+cg.period:""} · target {cg.prefix||""}{cg.target}{cg.suffix||""}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  var hidden=goals.hidden||{};
  var hiddenKeys=Object.keys(hidden).filter(function(k){return hidden[k];});
  var hiddenLabels={daily:"Today's P&L",weekly:"Week P&L",monthly:"Month P&L",winRate:"Win Rate",discipline:"Discipline Score",account:"Account Balance",withdrawals:"Total Withdrawn"};

  function renderStandardCard(key,opts){
    if(hidden[key])return null;
    return <GoalRing key={key} {...opts} onHide={function(){hide(key);}}/>;
  }

  // CHANGED: Lifted to outer scope so default-section inline cards can render full edit/delete UI.
  function renderCustomGoal(cg){
    var val=getCustomVal(cg);
    var tgtNum=parseFloat(cg.target)||0;
    var isEditing=editingCustomId===cg.id;
    if(isEditing&&customDraft){
      var editCanSave=customDraft.title.trim().length>0&&customDraft.target!==""&&!isNaN(parseFloat(customDraft.target))&&(customDraft.metric!=="custom"||(customDraft.customName||"").trim().length>0);
      return (
        <div key={cg.id} style={CS({marginBottom:12,border:"1px solid #4338ca",gridColumn:"1 / -1"})}>
          <div style={{fontSize:13,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:10}}>Edit Goal</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:10}}>
            <div><label style={lbl}>Title</label><input value={customDraft.title} onChange={function(e){var v=e.target.value;setCustomDraft(function(d){return Object.assign({},d,{title:v});});}} style={fld}/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div><label style={lbl}>Metric</label><Dropdown value={customDraft.metric} onChange={function(v){setCustomDraft(function(d){return Object.assign({},d,{metric:v,prefix:defaultPrefixForMetric(v),suffix:defaultSuffixForMetric(v)});});}} options={[{v:"pnl",l:"Total P&L"},{v:"winrate",l:"Win Rate (%)"},{v:"discipline",l:"Discipline Score"},{v:"trades",l:"Trades Taken"},{v:"balance",l:"Account Balance"},{v:"custom",l:"Custom..."}]}/></div>
              <div><label style={lbl}>Period</label><Dropdown value={customDraft.period} onChange={function(v){setCustomDraft(function(d){return Object.assign({},d,{period:v});});}} options={[{v:"daily",l:"Daily"},{v:"weekly",l:"Weekly"},{v:"monthly",l:"Monthly"},{v:"all",l:"All Time"}]}/></div>
            </div>
            {customDraft.metric==="custom"&&<div><label style={lbl}>Metric Name</label><input value={customDraft.customName||""} onChange={function(e){var v=e.target.value;setCustomDraft(function(d){return Object.assign({},d,{customName:v});});}} placeholder="e.g. R-multiple" style={fld}/></div>}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div><label style={lbl}>Target</label><input type="number" value={customDraft.target} onChange={function(e){var v=e.target.value;setCustomDraft(function(d){return Object.assign({},d,{target:v});});}} style={fld}/></div>
              <div><label style={lbl}>Prefix / Suffix</label><div style={{display:"flex",gap:4}}>
                <input value={customDraft.prefix||""} onChange={function(e){var v=e.target.value;setCustomDraft(function(d){return Object.assign({},d,{prefix:v});});}} placeholder="$" style={Object.assign({},fld,{flex:1})}/>
                <input value={customDraft.suffix||""} onChange={function(e){var v=e.target.value;setCustomDraft(function(d){return Object.assign({},d,{suffix:v});});}} placeholder="" style={Object.assign({},fld,{flex:1})}/>
              </div></div>
            </div>
            <div><label style={lbl}>Deadline (optional)</label><input type="date" onMouseDown={function(e){var inp=e.currentTarget;setTimeout(function(){try{inp.focus();if(inp.showPicker)inp.showPicker();}catch(err){}},0);}} value={customDraft.deadline||""} onChange={function(e){var v=e.target.value;setCustomDraft(function(d){return Object.assign({},d,{deadline:v});});}} style={Object.assign({},fld,{colorScheme:"dark",color:"#e2e8f0"})}/></div>
            {/* CHANGED: Section selector in EDIT mirrors the new-goal form — file the goal under
               a default section, the Custom bucket, an existing named section, or a brand-new one. */}
            <div>
              <label style={lbl}>Section</label>
              <Dropdown value={(function(){var sec=customDraft.section;if(sec==="namedCustom"&&customDraft.sectionName)return "existing:"+customDraft.sectionName;return sec||"custom";})()} onChange={function(v){setCustomDraft(function(d){
                if(v==="newCustom")return Object.assign({},d,{section:"newCustom",sectionName:""});
                if(v.indexOf("existing:")===0)return Object.assign({},d,{section:"namedCustom",sectionName:v.slice("existing:".length)});
                return Object.assign({},d,{section:v,sectionName:null});
              });}} options={[{v:"custom",l:"Custom Goals (default)"},{v:"performance",l:"Performance"},{v:"pnl",l:"P&L"},{v:"account",l:"Account"}].concat(Array.from(new Set((goals.custom||[]).filter(function(g){return g.section==="namedCustom"&&g.sectionName;}).map(function(g){return g.sectionName;}))).map(function(name){return {v:"existing:"+name,l:name};})).concat([{v:"newCustom",l:"＋ Create new section…"}])}/>
              {customDraft.section==="newCustom"&&(
                <input value={customDraft.sectionName||""} onChange={function(e){var v=e.target.value;setCustomDraft(function(d){return Object.assign({},d,{sectionName:v});});}} placeholder="New section name" style={Object.assign({},fld,{marginTop:6})}/>
              )}
            </div>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button onClick={function(){setEditingCustomId(null);setCustomDraft(null);}} style={{flex:1,padding:"9px",background:"none",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>Cancel</button>
            <button onClick={function(){if(!editCanSave)return;
              // CHANGED: Normalize section — a freshly-named new section becomes "namedCustom" with sectionName.
              var sec=customDraft.section||"custom";var sname=customDraft.sectionName||null;
              if(sec==="newCustom"){if(sname&&sname.trim().length>0){sec="namedCustom";sname=sname.trim();}else{sec="custom";sname=null;}}
              if(sec!=="namedCustom")sname=null;
              updateCustom(cg.id,{title:customDraft.title.trim(),target:customDraft.target,metric:customDraft.metric,period:customDraft.period,prefix:customDraft.prefix||"",suffix:customDraft.suffix||"",deadline:customDraft.deadline||null,customName:customDraft.metric==="custom"?(customDraft.customName||"").trim():null,filterField:customDraft.filterField||"",filterValue:customDraft.filterValue||"",section:sec,sectionName:sname});
              setEditingCustomId(null);setCustomDraft(null);
            }} disabled={!editCanSave} style={{flex:2,padding:"9px",background:editCanSave?"#4f46e5":"#1e293b",border:"none",borderRadius:6,color:editCanSave?"#fff":"#475569",fontSize:13,cursor:editCanSave?"pointer":"not-allowed",fontFamily:"inherit",fontWeight:700}}>Save</button>
          </div>
        </div>
      );
    }
    return (
      <div key={cg.id} style={{position:"relative"}}>
        <GoalRing label={cg.title+(cg.metric==="custom"&&cg.customName?" ("+cg.customName+")":"")} value={val} target={tgtNum} prefix={cg.prefix||""} suffix={cg.suffix||""} decimals={cg.metric==="winrate"||cg.metric==="discipline"||cg.metric==="trades"?0:2} targetDecimals={cg.metric==="winrate"||cg.metric==="discipline"||cg.metric==="trades"?0:0} wrColor={cg.metric==="winrate"} discColor={cg.metric==="discipline"} onDelete={function(){
          // Two-step confirm via window.confirm — matches the lightweight × treatment of default cards.
          if(confirm("Delete custom goal \""+cg.title+"\"?"))delCustom(cg.id);
        }}/>
      </div>
    );
  }

  return (
    <div style={{paddingTop:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0"}}>Goals</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={function(){setShowAdd(function(o){return !o;});}} style={{padding:"8px 14px",background:showAdd?"#1e293b":"#14532d",border:"1px solid "+(showAdd?"#475569":"#166534"),borderRadius:6,color:showAdd?"#94a3b8":"#86efac",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{showAdd?"Cancel":"+ Add Goal"}</button>
          <button onClick={function(){setDraft(normalizeStored(goals));setEditing(true);}} style={{padding:"8px 14px",background:"#1e1b4b",border:"1px solid #4338ca",borderRadius:6,color:"#a5b4fc",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Edit</button>
        </div>
      </div>

      {hiddenKeys.length>0&&(
        <div style={{padding:"8px 12px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:8,marginBottom:12}}>
          <div style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:6}}>Hidden ({hiddenKeys.length})</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {hiddenKeys.map(function(k){return <button key={k} onClick={function(){unhide(k);}} style={{padding:"3px 9px",background:"#1e293b",border:"1px solid #334155",borderRadius:4,color:"#cbd5e1",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>+ {hiddenLabels[k]||k}</button>;})}
          </div>
        </div>
      )}

      {showAdd&&(
        <div style={CS({marginBottom:14,border:"1px solid #4338ca"})}>
          <div style={{fontSize:13,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:10}}>New Custom Goal</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:10}}>
            <div><label style={lbl}>Title</label><input value={newGoal.title} onChange={function(e){setNewGoal(function(g){return Object.assign({},g,{title:e.target.value});});}} placeholder="e.g. Hit 10 A-grade trades" style={fld}/></div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div>
                <label style={lbl}>Metric</label>
                <Dropdown value={newGoal.metric} onChange={function(m){setNewGoal(function(g){return Object.assign({},g,{metric:m,prefix:defaultPrefixForMetric(m),suffix:defaultSuffixForMetric(m)});});}} options={[{v:"pnl",l:"Total P&L"},{v:"winrate",l:"Win Rate (%)"},{v:"discipline",l:"Discipline Score"},{v:"trades",l:"Trades Taken"},{v:"balance",l:"Account Balance"},{v:"custom",l:"Custom..."}]}/>
              </div>
              <div>
                <label style={lbl}>Period</label>
                <Dropdown value={newGoal.period} onChange={function(v){setNewGoal(function(g){return Object.assign({},g,{period:v});});}} options={[{v:"daily",l:"Daily"},{v:"weekly",l:"Weekly"},{v:"monthly",l:"Monthly"},{v:"all",l:"All Time"}]}/>
              </div>
            </div>
            {/* CHANGED: Custom metric input fields */}
            {newGoal.metric==="custom"&&(
              <div>
                <label style={lbl}>Metric Name</label>
                <input value={newGoal.customName} onChange={function(e){setNewGoal(function(g){return Object.assign({},g,{customName:e.target.value});});}} placeholder="e.g. R-multiple" style={fld}/>
                <div style={{fontSize:11,color:"#64748b",marginTop:3}}>You'll manually update the current value on the goal card.</div>
              </div>
            )}
            {/* CHANGED: Filter by trade form option (setup/grade/indicator/etc) */}
            {newGoal.metric!=="custom"&&newGoal.metric!=="balance"&&newGoal.metric!=="discipline"&&(function(){
              var opts=props.tradeOptions||defaultOptions();
              var fieldOpts=[
                {key:"",label:"None (all trades)",values:[]},
                {key:"setup",label:"Setup",values:opts.setup||[]},
                {key:"grade",label:"Grade",values:["A","B","C","D","F"]},
                {key:"direction",label:"Direction",values:["LONG","SHORT","CALL","PUT","BUY","SELL"]},
                {key:"timeframe",label:"Timeframe",values:opts.timeframe||[]},
                {key:"candlePattern",label:"Candle Pattern",values:opts.candlePattern||[]},
                {key:"indicators",label:"Indicator",values:opts.indicator||[]},
                {key:"emotions",label:"Emotion",values:opts.emotion||[]},
                {key:"violations",label:"Violation",values:ALL_VIOLATIONS},
                {key:"assetClass",label:"Asset Class",values:ASSET_CLASS_ORDER}
              ];
              var selectedField=fieldOpts.find(function(f){return f.key===newGoal.filterField;})||fieldOpts[0];
              return (
                <div style={{padding:"8px 10px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:6,marginTop:4}}>
                  <div style={{fontSize:10,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:6}}>Filter by Trade Field (optional)</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <Dropdown value={newGoal.filterField||""} onChange={function(v){setNewGoal(function(g){return Object.assign({},g,{filterField:v,filterValue:""});});}} options={fieldOpts.map(function(f){return {v:f.key,l:f.label};})}/>
                    {newGoal.filterField&&(
                      <Dropdown value={newGoal.filterValue||""} onChange={function(v){setNewGoal(function(g){return Object.assign({},g,{filterValue:v});});}} placeholder="Select value..." options={[{v:"",l:"Select value..."}].concat(selectedField.values.map(function(v){return {v:v,l:v};}))}/>
                    )}
                  </div>
                  {newGoal.filterField&&newGoal.filterValue&&(
                    <div style={{fontSize:11,color:"#86efac",marginTop:6}}>Goal will only count trades where {selectedField.label} = "{newGoal.filterValue}"</div>
                  )}
                </div>
              );
            })()}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              <div><label style={lbl}>Target</label><input type="number" value={newGoal.target} onChange={function(e){setNewGoal(function(g){return Object.assign({},g,{target:e.target.value});});}} placeholder="100" style={fld}/></div>
              <div><label style={lbl}>Prefix / Suffix</label>
                <div style={{display:"flex",gap:4}}>
                  <input value={newGoal.prefix} onChange={function(e){setNewGoal(function(g){return Object.assign({},g,{prefix:e.target.value});});}} placeholder="$" style={Object.assign({},fld,{flex:1})}/>
                  <input value={newGoal.suffix} onChange={function(e){setNewGoal(function(g){return Object.assign({},g,{suffix:e.target.value});});}} placeholder="" style={Object.assign({},fld,{flex:1})}/>
                </div>
              </div>
            </div>
            {/* CHANGED: Optional deadline date. */}
            <div style={{marginTop:8}}>
              <label style={lbl}>Deadline (optional)</label>
              <input type="date" onMouseDown={function(e){var inp=e.currentTarget;setTimeout(function(){try{inp.focus();if(inp.showPicker)inp.showPicker();}catch(err){}},0);}} value={newGoal.deadline||""} onChange={function(e){setNewGoal(function(g){return Object.assign({},g,{deadline:e.target.value});});}} style={Object.assign({},fld,{colorScheme:"dark",color:"#e2e8f0"})}/>
            </div>
            {/* CHANGED: Section selector — file the goal under an existing section, the default Custom bucket, or a new named section. */}
            <div style={{marginTop:8}}>
              <label style={lbl}>Section</label>
              <Dropdown value={newGoal.section||"custom"} onChange={function(v){setNewGoal(function(g){return Object.assign({},g,{section:v,sectionName:v==="newCustom"?"":g.sectionName});});}} options={[{v:"custom",l:"Custom Goals (default)"},{v:"performance",l:"Performance"},{v:"pnl",l:"P&L"},{v:"account",l:"Account"}].concat(Array.from(new Set((goals.custom||[]).filter(function(g){return g.section==="namedCustom"&&g.sectionName;}).map(function(g){return g.sectionName;}))).map(function(name){return {v:"existing:"+name,l:name};})).concat([{v:"newCustom",l:"＋ Create new section…"}])}/>
              {newGoal.section==="newCustom"&&(
                <input value={newGoal.sectionName||""} onChange={function(e){var v=e.target.value;setNewGoal(function(g){return Object.assign({},g,{sectionName:v});});}} placeholder="New section name" style={Object.assign({},fld,{marginTop:6})}/>
              )}
            </div>
          </div>
          {/* CHANGED: Save button gives feedback when fields incomplete */}
          {!canSaveCustom&&<div style={{fontSize:12,color:"#fdba74",marginTop:10,padding:"6px 10px",background:"#1c1108",border:"1px solid #713f12",borderRadius:6}}>Fill in title, target{newGoal.metric==="custom"?", and metric name":""} to save.</div>}
          <button onClick={addCustom} disabled={!canSaveCustom} style={{width:"100%",padding:"11px",background:canSaveCustom?"linear-gradient(135deg,#4f46e5,#6366f1)":"#1e293b",color:canSaveCustom?"#fff":"#475569",border:"none",borderRadius:8,fontSize:14,fontWeight:700,cursor:canSaveCustom?"pointer":"not-allowed",fontFamily:"inherit",marginTop:10}}>Save Goal</button>
        </div>
      )}

      {/* CHANGED: Standard goals organized into categories — Account Activity, Performance, P&L. */}
      {(function(){
        var hasAccount=(!hidden.account&&accountTarget>0)||(!hidden.withdrawals&&withdrawalTarget>0);
        var hasPerf=(!hidden.winRate&&winRateTarget>0)||(!hidden.discipline&&disciplineTarget>0);
        var hasPnL=(!hidden.daily&&dailyTarget>0)||(!hidden.weekly&&weeklyTarget>0)||(!hidden.monthly&&monthlyTarget>0);
        // CHANGED: Pre-bucket custom goals so they can render inline within their assigned default section.
        var customAll=goals.custom||[];
        var customByBucket={performance:[],pnl:[],account:[]};
        customAll.forEach(function(cg){if(customByBucket[cg.section])customByBucket[cg.section].push(cg);});
        if(customByBucket.performance.length>0)hasPerf=true;
        if(customByBucket.pnl.length>0)hasPnL=true;
        if(customByBucket.account.length>0)hasAccount=true;
        function SectionHead(p){return <div style={{display:"flex",alignItems:"center",gap:8,margin:"4px 0 10px"}}><span style={{fontSize:13}}>{p.icon}</span><span style={{fontSize:12,color:"#cbd5e1",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700}}>{p.title}</span><div style={{flex:1,height:1,background:"#1e293b"}}/></div>;}
        var gridStyle={display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax("+(props.mobile?"140px":"190px")+",1fr))",gap:props.mobile?8:12,alignItems:"stretch"};
        // CHANGED: Use the lifted renderCustomGoal so inline cards have full edit/delete + edit form.
        function renderInlineCustom(cg){return renderCustomGoal(cg);}
        return (
          <div>
            {hasAccount&&(
              <div style={{marginBottom:20}}>
                <SectionHead icon="🏦" title="Account Activity"/>
                <div style={gridStyle}>
                  {!hidden.account&&accountTarget>0&&renderStandardCard("account",{label:"Account Balance",value:currentAccount,target:accountTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true})}
                  {withdrawalTarget>0&&renderStandardCard("withdrawals",{label:"Total Withdrawn",value:totalWithdrawn,target:withdrawalTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true})}
                  {customByBucket.account.map(renderInlineCustom)}
                </div>
              </div>
            )}
            {hasPerf&&(
              <div style={{marginBottom:20}}>
                <SectionHead icon="🎯" title="Performance"/>
                <div style={gridStyle}>
                  {winRateTarget>0&&renderStandardCard("winRate",{label:"Win Rate",value:oWR,target:winRateTarget,suffix:"%",decimals:0,targetDecimals:0,wrColor:true,subtext:(weekTrades.length>0?("This week: "+Math.round(wWR)+"% ("+weekWins+"/"+weekTrades.length+")"):"This week: no trades yet")+" · all-time above"})}
                  {disciplineTarget>0&&renderStandardCard("discipline",{label:"Discipline Score",value:aDisc,target:disciplineTarget,suffix:"%",decimals:0,targetDecimals:0,discColor:true,subtext:(discWeekDays.length>0?("This week: "+Math.round(aDiscWeek)+"% avg ("+discWeekDays.length+" day"+(discWeekDays.length===1?"":"s")+")"):"This week: no trades yet")+" · stay above your "+disciplineTarget+"% lock threshold"})}
                  {customByBucket.performance.map(renderInlineCustom)}
                </div>
              </div>
            )}
            {hasPnL&&(
              <div style={{marginBottom:20}}>
                <SectionHead icon="💰" title="P&L"/>
                <div style={gridStyle}>
                  {dailyTarget>0&&renderStandardCard("daily",Object.assign({label:"Today's P&L",value:dailyPnL,target:dailyTarget,prefix:"$",decimals:0,targetDecimals:0},pnlFmt))}
                  {weeklyTarget>0&&renderStandardCard("weekly",Object.assign({label:"Week P&L",value:weekPnL,target:weeklyTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true},pnlFmt))}
                  {monthlyTarget>0&&renderStandardCard("monthly",Object.assign({label:"Month P&L",value:monthPnL,target:monthlyTarget,prefix:"$",decimals:0,targetDecimals:0,markComplete:true},pnlFmt))}
                  {customByBucket.pnl.map(renderInlineCustom)}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* No standard goals + no custom goals = empty state */}
      {!showAdd&&dailyTarget===0&&weeklyTarget===0&&monthlyTarget===0&&winRateTarget===0&&accountTarget===0&&withdrawalTarget===0&&(goals.custom||[]).length===0&&(
        <div style={{textAlign:"center",padding:"40px 20px",color:"#475569"}}>
          
          <div style={{fontSize:15}}>No custom goals set yet</div>
          <div style={{fontSize:13,color:"#64748b",marginTop:4}}>Your discipline target tracks your lock threshold by default. Tap Edit to set P&L or win-rate targets, or Add Goal for a custom one.</div>
        </div>
      )}

      {/* CHANGED: Custom goals are now grouped by their assigned section. Default bucket is "Custom Goals";
          others appear under "Performance · Custom", "P&L · Custom", "Account · Custom", or named custom sections. */}
      {(function(){
        var all=goals.custom||[];
        if(all.length===0)return null;
        // The per-goal renderer (was previously inlined here as a single map; extracted so it can be reused
        // across multiple section buckets).
        // Bucket by section.
        var buckets={custom:[],performance:[],pnl:[],account:[]};
        var named={};
        all.forEach(function(cg){
          if(cg.section==="performance")buckets.performance.push(cg);
          else if(cg.section==="pnl")buckets.pnl.push(cg);
          else if(cg.section==="account")buckets.account.push(cg);
          else if(cg.section==="namedCustom"&&cg.sectionName){if(!named[cg.sectionName])named[cg.sectionName]=[];named[cg.sectionName].push(cg);}
          else buckets.custom.push(cg);
        });
        var hdr={fontSize:12,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:8};
        function renderBucket(label,items,key){
          if(!items||items.length===0)return null;
          return (
            <div key={key} style={{marginTop:8}}>
              <div style={hdr}>{label}</div>
              {items.map(renderCustomGoal)}
            </div>
          );
        }
        return (
          <>
            {renderBucket("Custom Goals",buckets.custom,"custom")}
            {Object.keys(named).map(function(name){return renderBucket(name,named[name],"named-"+name);})}
          </>
        );
      })()}
    </div>
  );
}

// CHANGED: Module-scope collapsible section (StatSec) and row (StatRow) for Performance tab.
// CHANGED: StatSec now accepts an optional `sparkline` (array of numbers) — renders a tiny inline
// trend chart next to the preview on collapsed headers. Color = green if last value ≥ first.
function StatSec(props){
  // CHANGED: No more expand/collapse. Clean panel with a label header and content below.
  // Sized to be placed inside a CSS-columns masonry container or grid container.
  var span=props.colSpan;
  var outer={background:"#111118",border:"1px solid #1e293b",borderRadius:10,overflow:"hidden",display:"flex",flexDirection:"column",breakInside:"avoid",WebkitColumnBreakInside:"avoid",pageBreakInside:"avoid",marginBottom:16,width:"100%"};
  if(span)outer.gridColumn="span "+span;
  return (
    <div style={outer}>
      <div style={{padding:"11px 16px",borderBottom:"1px solid #1e293b",background:"#0d0d14"}}>
        <span style={{fontSize:11,color:"#94a3b8",letterSpacing:1.2,textTransform:"uppercase",fontWeight:700}}>{props.title}</span>
      </div>
      <div style={{padding:"12px 16px",flex:1,minWidth:0}}>{props.children}</div>
    </div>
  );
}
// CHANGED: StatRow — baseline-aligned with tabular numerals so columns of numbers line up cleanly.
function StatRow(props){return <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"7px 0",borderBottom:props.last?"none":"1px solid #1e293b",gap:8}}><span style={{fontSize:13,color:"#94a3b8"}}>{props.label}</span><span style={{fontSize:13,color:props.color||"#e2e8f0",fontWeight:600,fontVariantNumeric:"tabular-nums"}}>{props.value}</span></div>;}

// CHANGED: StatTile — compact stat card used in grid layouts (e.g. Overview). Same visual language
// as the summary panels at the top of the page (small uppercase label, big colored number).
// Now optionally clickable (props.onClick) with an `active` outline state.
function StatTile(props){
  var clickable=typeof props.onClick==="function";
  var active=!!props.active;
  var base={padding:"8px 10px",background:active?"#1a1830":"#0a0a0f",border:"1px solid "+(active?"#6366f1":"#1e293b"),borderRadius:6,minWidth:0,overflow:"hidden",fontFamily:"inherit",textAlign:"left",cursor:clickable?"pointer":"default",transition:"background 80ms, border-color 80ms"};
  var inner=(
    <>
      <div style={{fontSize:9,color:active?"#a5b4fc":"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{props.label}</div>
      <div style={{fontSize:17,fontWeight:700,color:props.color||"#e2e8f0",marginTop:2,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{props.value}</div>
      {props.sub&&<div style={{fontSize:10,color:"#94a3b8",marginTop:1,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{props.sub}</div>}
    </>
  );
  if(clickable)return <button onClick={props.onClick} style={Object.assign(base,{width:"100%",display:"block"})}>{inner}</button>;
  return <div style={base}>{inner}</div>;
}

// CHANGED: HBar — horizontal bar row for ranked breakdowns (setups, patterns, indicators). The bar
// length is proportional to value/max, color codes positive/negative, count shown alongside.
function HBar(props){
  var max=props.max||1;
  var w=max>0?Math.max(2,Math.min(100,Math.abs(props.value)/max*100)):0;
  var col=props.value>=0?"#22c55e":"#ef4444";
  return (
    <div style={{padding:"7px 0",borderBottom:props.last?"none":"1px solid #1e293b"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8,marginBottom:4}}>
        <span style={{fontSize:12,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0}}>{props.label}</span>
        <span style={{fontSize:11,color:col,fontWeight:700,fontVariantNumeric:"tabular-nums",flexShrink:0}}>{props.valueLabel}<span style={{fontSize:10,color:"#94a3b8",fontWeight:500,marginLeft:6}}>{props.sub}</span></span>
      </div>
      <div style={{height:5,background:"#0a0a0f",borderRadius:3,overflow:"hidden",position:"relative"}}>
        <div style={{height:"100%",width:w+"%",background:col,opacity:0.85,borderRadius:3}}/>
      </div>
    </div>
  );
}

// CHANGED: PerformanceTab — Avg Win, Avg Loss, Expectancy now respect HIDE_DOLLAR_PNL.
// CHANGED: AI Coach — generates a summary + focus suggestion, and answers freeform questions about the trader's stats.
function AICoach(props){
  var [open,setOpen]=useState(false);
  var [loading,setLoading]=useState(false);
  // CHANGED: Persist result/answer to localStorage so they survive tab switches until cleared.
  var [result,setResult]=useState(function(){try{var s=localStorage.getItem("tf-aicoach-result");return s?JSON.parse(s):null;}catch(e){return null;}});
  var [error,setError]=useState(null);
  var [question,setQuestion]=useState(function(){try{return localStorage.getItem("tf-aicoach-question")||"";}catch(e){return "";}});
  var [qLoading,setQLoading]=useState(false);
  var [answer,setAnswer]=useState(function(){try{return localStorage.getItem("tf-aicoach-answer")||null;}catch(e){return null;}});
  useEffect(function(){try{if(result)localStorage.setItem("tf-aicoach-result",JSON.stringify(result));else localStorage.removeItem("tf-aicoach-result");}catch(e){}},[result]);
  useEffect(function(){try{if(answer)localStorage.setItem("tf-aicoach-answer",answer);else localStorage.removeItem("tf-aicoach-answer");}catch(e){}},[answer]);
  useEffect(function(){try{localStorage.setItem("tf-aicoach-question",question);}catch(e){}},[question]);
  function statsBlock(){
    var s=props.stats;
    function line(label,val){return (val==null||val===""||val==="n/a")?"":label+": "+val+"\n";}
    return "Trader's stats ("+(s.rangeLabel||"selected range")+"):\n"+
      line("Total trades",s.totalTrades)+
      line("Win rate",s.winRate+"%")+
      line("Breakeven rate",s.breakevenRate+"%")+
      line("Profit factor",s.pf)+
      line("Avg win",s.avgWinPct)+
      line("Avg loss",s.avgLossPct)+
      line("Expectancy per trade",s.expectancyPct+" ("+s.expectancyR+")")+
      line("Best / worst setup",(s.bestSetup||"n/a")+" / "+(s.worstSetup||"n/a"))+
      line("Best / worst session",(s.bestSession||"n/a")+" / "+(s.worstSession||"n/a"))+
      line("Best / worst emotion tag",(s.bestEmotion||"n/a")+" / "+(s.worstEmotion||"n/a"))+
      line("Best / worst direction",(s.bestDirection||"n/a")+" / "+(s.worstDirection||"n/a"))+
      line("Best / worst instrument",(s.bestInstrument||"n/a")+" / "+(s.worstInstrument||"n/a"))+
      line("Best / worst timeframe",(s.bestTimeframe||"n/a")+" / "+(s.worstTimeframe||"n/a"))+
      line("Most common violation",(s.topViolation||"none"))+
      line("Violation rate",s.violationRate)+
      line("Avg discipline score",s.avgDiscipline+" (lock threshold "+s.disciplineThreshold+")")+
      line("Avg trade % on disciplined vs undisciplined days",s.avgTradePctOnDisciplinedDays+" vs "+s.avgTradePctOnUndisciplinedDays)+
      line("Avg trades/day (max in a day)",s.avgTradesPerDay+" ("+s.maxTradesInADay+")")+
      line("Avg % after a losing trade vs overall",s.avgPctAfterALoss+" vs "+s.overallAvgPct)+
      line("Recent form: last 10 trades vs prior",s.last10AvgPct+" vs "+s.priorAvgPct)+
      line("Grade distribution",s.gradeDistribution);
  }
  function callAPI(prompt,onText){
    // CHANGED: Use the user-provided Anthropic API key (stored in Settings → AI Coach). Without
    // it the deployed web app can't reach the Anthropic API. The dangerous-direct-browser flag
    // is required for direct browser-to-anthropic.com calls.
    var apiKey="";try{apiKey=localStorage.getItem("tf-anthropic-key")||"";}catch(e){}
    if(!apiKey){
      return Promise.reject(new Error("No Anthropic API key set. Add yours in Settings → AI Coach."));
    }
    return fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key":apiKey,
        "anthropic-version":"2023-06-01",
        "anthropic-dangerous-direct-browser-access":"true"
      },
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content:prompt}]})
    }).then(function(r){return r.json();}).then(function(data){
      if(data&&data.error){throw new Error(data.error.message||"API error");}
      var text=(data.content||[]).filter(function(b){return b.type==="text";}).map(function(b){return b.text;}).join("");
      if(!text)throw new Error("Empty response");
      onText(text);
    });
  }
  function generate(){
    setLoading(true);setError(null);setResult(null);
    var prompt="You are an elite trading performance coach reviewing one trader's data. Be specific and personal — cite their actual numbers and named setups/sessions/emotions, never generic platitudes. Identify the single most important pattern in THIS data (e.g. a setup or session that's bleeding money, a discipline-to-outcome link, revenge-trading after losses, overtrading, or a declining recent trend) and explain it using the figures.\n\nWrite a 2-3 sentence summary of their performance grounded in the specifics, then ONE concrete, actionable focus suggestion that names exactly what to change and is tied to a number from the data. Do not use markdown headers.\n\n"+statsBlock()+"\n\nFormat your response as JSON: {\"summary\":\"...\",\"focus\":\"...\"}. Return only JSON, no preamble or markdown.";
    callAPI(prompt,function(text){
      var clean=text.replace(/```json|```/g,"").trim();
      try{setResult(JSON.parse(clean));}catch(e){setResult({summary:clean,focus:""});}
      setLoading(false);
    }).catch(function(e){setError(e&&e.message?e.message:"Couldn't generate insights. Try again.");setLoading(false);});
  }
  function ask(){
    var q=question.trim();if(!q)return;
    setQLoading(true);setAnswer(null);
    var prompt="You are a sharp, direct trading performance coach. Answer the trader's question using ONLY their data below, citing specific numbers, setups, sessions or emotions where relevant. If the data doesn't support an answer, say so plainly rather than guessing. Keep it to 2-4 sentences, actionable, no markdown headers.\n\n"+statsBlock()+"\n\nQuestion: "+q;
    callAPI(prompt,function(text){setAnswer(text.trim());setQLoading(false);}).catch(function(e){setAnswer("Couldn't get an answer: "+(e&&e.message?e.message:"unknown error")+". Try again.");setQLoading(false);});
  }
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"linear-gradient(135deg,#1a1a2e,#16213e)",border:"1px solid #4338ca",borderRadius:10}}>
      <div onClick={function(){setOpen(function(o){return !o;});}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:(open&&(result||loading))?10:0,cursor:"pointer",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <span style={{fontSize:14}}>🪄</span>
          <span style={{fontSize:11,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>AI Coach</span>
          <span style={{fontSize:11,color:"#cbd5e1"}}>{open?"▴":"▾"}</span>
        </div>
        {open&&(
          <div style={{display:"flex",gap:6,alignItems:"center"}} onClick={function(e){e.stopPropagation();}}>
            {result&&<button onClick={function(){setResult(null);setError(null);}} style={{padding:"5px 10px",background:"transparent",border:"1px solid #334155",borderRadius:6,color:"#cbd5e1",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>}
            <button onClick={generate} disabled={loading} style={{padding:"5px 12px",background:loading?"#1e293b":"#4338ca",border:"1px solid #6366f1",borderRadius:6,color:loading?"#94a3b8":"#fff",fontSize:12,fontWeight:600,cursor:loading?"default":"pointer",fontFamily:"inherit"}}>{loading?"Analyzing…":(result?"Regenerate":"Generate Insights")}</button>
          </div>
        )}
      </div>
      {open&&<>
      {error&&<div style={{fontSize:12,color:"#fca5a5",marginTop:8}}>{error}</div>}
      {result&&(
        <div>
          <div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.6,marginBottom:result.focus?10:0}}>{result.summary}</div>
          {result.focus&&(
            <div style={{padding:"8px 10px",background:"#0a1f1066",border:"1px solid #166534",borderRadius:6}}>
              <div style={{fontSize:10,color:"#86efac",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:3}}>Focus</div>
              <div style={{fontSize:13,color:"#bbf7d0",lineHeight:1.5}}>{result.focus}</div>
            </div>
          )}
        </div>
      )}
      {!result&&!loading&&!error&&<div style={{fontSize:12,color:"#cbd5e1",marginTop:8,lineHeight:1.55}}>Get an AI-generated summary of your performance and a focus suggestion, or ask a question below.</div>}
      {/* CHANGED: Ask-a-question input. */}
      <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #ffffff14"}}>
        <div style={{display:"flex",gap:6}}>
          <input value={question} onChange={function(e){setQuestion(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")ask();}} placeholder="Ask about your trading…" style={{flex:1,padding:"7px 10px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,color:"#e2e8f0",fontSize:13,fontFamily:"inherit",boxSizing:"border-box"}}/>
          <button onClick={ask} disabled={qLoading||!question.trim()} style={{padding:"7px 14px",background:qLoading||!question.trim()?"#1e293b":"#4338ca",border:"1px solid #6366f1",borderRadius:6,color:qLoading||!question.trim()?"#94a3b8":"#fff",fontSize:13,fontWeight:600,cursor:qLoading||!question.trim()?"default":"pointer",fontFamily:"inherit",flexShrink:0}}>{qLoading?"…":"Ask"}</button>
        </div>
        {answer&&(
          <div style={{marginTop:8,padding:"8px 10px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
              <div style={{fontSize:13,color:"#cbd5e1",lineHeight:1.6,flex:1}}>{answer}</div>
              <button onClick={function(){setAnswer(null);setQuestion("");}} style={{background:"transparent",border:"none",color:"#94a3b8",fontSize:16,cursor:"pointer",padding:"0 2px",lineHeight:1,flexShrink:0}}>×</button>
            </div>
          </div>
        )}
      </div>
      </>}
    </div>
  );
}
// CHANGED: Equity curve summary — running cumulative P&L over the filtered period plus a
// high-water-mark line. Shows current value, max drawdown, and best peak inline.
// CHANGED: MetricChart — small SVG line chart used by the combined Overview block to plot any
// metric over time (running win rate, profit factor, expectancy, trade count, etc). Total P&L
// gets its own richer EquityCurve component; everything else routes here. Supports the same
// hover/drag crosshair as EquityCurve so the readout updates as the user scrubs across.
function MetricChart(props){
  var entries=props.entries||[];
  var label=props.label||"";
  var color=props.color||"#a5b4fc";
  var compute=props.compute;
  var [hoverIdx,setHoverIdx]=useState(null);
  var svgRef=React.useRef(null);
  if(entries.length===0||typeof compute!=="function")return null;
  var sorted=entries.slice().sort(function(a,b){return new Date(a.date)-new Date(b.date);});
  // CHANGED: minTrades prop gates the chart until enough trades have accumulated. For rate-based
  // metrics (WR, PF, expectancy, etc.) early data is meaningless — a 1-trade WR is either 0% or
  // 100%. Default 20 is a common floor for stat-noise reduction.
  var minTrades=props.minTrades!=null?props.minTrades:0;
  var pts=[];
  for(var i=0;i<sorted.length;i++){
    var slice=sorted.slice(0,i+1);
    if(minTrades>0){
      var nT=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){if(t&&t.status!=="open")nT++;});});
      if(nT<minTrades)continue;
    }
    var v=compute(slice);
    if(v!=null&&!isNaN(v))pts.push({date:sorted[i].date,v:v});
  }
  if(pts.length<1)return <div style={{padding:24,textAlign:"center",fontSize:12,color:"#64748b"}}>{minTrades>0?("Need at least "+minTrades+" trades for a meaningful trend."):"Not enough data to chart."}</div>;
  // CHANGED: Geometry + visuals match EquityCurve — same viewBox, area fill, dashed baseline,
  // footer with first/last/peak labels — so all charts in the Overview block read consistently.
  var W=320,H=80,padX=4,padY=6;
  var minV=Math.min.apply(null,pts.map(function(p){return p.v;}));
  var maxV=Math.max.apply(null,pts.map(function(p){return p.v;}));
  // Anchor baseline to 0 when the data straddles or is near 0 (rates, expectancy). When all values
  // are far from 0 (e.g. cumulative trade count), keep the range tight to maximize resolution.
  var anchorZero=(minV<=0&&maxV>=0)||(minV>=0&&minV<(maxV-minV)*0.25);
  if(anchorZero){if(minV>0)minV=0;if(maxV<0)maxV=0;}
  if(minV===maxV){minV-=1;maxV+=1;}
  function xFor(i){return padX+(pts.length<=1?W/2:(i/(pts.length-1))*(W-padX*2));}
  function yFor(v){return H-padY-((v-minV)/(maxV-minV))*(H-padY*2);}
  var linePath=pts.map(function(p,i){return (i===0?"M":"L")+xFor(i).toFixed(1)+","+yFor(p.v).toFixed(1);}).join("");
  // Area fill back down to the baseline (0 if anchored there, else minV).
  var baselineV=anchorZero?0:minV;
  var areaPath=linePath+"L"+xFor(pts.length-1).toFixed(1)+","+yFor(baselineV).toFixed(1)+"L"+xFor(0).toFixed(1)+","+yFor(baselineV).toFixed(1)+"Z";
  var first=pts[0];
  var last=pts[pts.length-1];
  var peak=pts.reduce(function(m,p){return p.v>m.v?p:m;},pts[0]);
  var display=hoverIdx!=null?pts[hoverIdx]:last;
  var delta=display.v-first.v;
  var fmt=props.format||function(v){return v.toFixed(2);};
  function handleMove(e){
    if(!svgRef.current)return;
    var rect=svgRef.current.getBoundingClientRect();
    var clientX=e.touches?e.touches[0].clientX:e.clientX;
    var px=clientX-rect.left;
    var ratio=Math.max(0,Math.min(1,px/rect.width));
    var idx=Math.round(ratio*(pts.length-1));
    if(idx<0)idx=0;if(idx>pts.length-1)idx=pts.length-1;
    setHoverIdx(idx);
  }
  function handleLeave(){setHoverIdx(null);}
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"#0d0d12",border:"1px solid #1e293b",borderRadius:10,display:"flex",flexDirection:"column",height:"100%",boxSizing:"border-box"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8,gap:8}}>
        <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
          <div style={{fontSize:20,fontWeight:700,color:color,fontVariantNumeric:"tabular-nums"}}>{fmt(display.v)}</div>
          {/* CHANGED: Optional meta label to the right of the value (e.g. total trading time on the Trades chart). */}
          {props.meta&&<div style={{fontSize:11,color:"#94a3b8",fontWeight:600,fontVariantNumeric:"tabular-nums"}}>{props.meta}</div>}
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Change</div>
          {/* CHANGED: Removed the manual "+" prefix — fmt() now owns its own sign for $/% formats,
             so prepending here produced "++2.85%". For raw-number formats fmt won't have a sign,
             so handle that case explicitly. */}
          {/* CHANGED: Change color can be inverted (loss rate, avg loss — where a rising value is
             BAD). With invertChange, a positive delta colors red and a negative delta green. */}
          <div style={{fontSize:13,fontWeight:700,color:(props.invertChange?delta<=0:delta>=0)?"#22c55e":"#ef4444",marginTop:4,fontVariantNumeric:"tabular-nums"}}>{(function(){var s=fmt(delta);if(/^[+\-]/.test(s))return s;return (delta>=0?"+":"")+s;})()}</div>
        </div>
      </div>
      <svg ref={svgRef} viewBox={"0 0 "+W+" "+H} style={{display:"block",width:"100%",height:"100%",flex:1,minHeight:120,touchAction:"none",cursor:"crosshair"}} preserveAspectRatio="none" onMouseMove={handleMove} onMouseLeave={handleLeave} onTouchStart={handleMove} onTouchMove={handleMove} onTouchEnd={handleLeave}>
        {anchorZero&&<line x1={padX} x2={W-padX} y1={yFor(0)} y2={yFor(0)} stroke="#334155" strokeWidth="0.5" strokeDasharray="2,2"/>}
        <path d={areaPath} fill={color+"22"} stroke="none"/>
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.5"/>
        {hoverIdx!=null&&(
          <g>
            <line x1={xFor(hoverIdx)} x2={xFor(hoverIdx)} y1={padY} y2={H-padY} stroke="#cbd5e1" strokeWidth="0.6" strokeDasharray="2,2"/>
            <circle cx={xFor(hoverIdx)} cy={yFor(display.v)} r="2.5" fill={color} stroke="#fff" strokeWidth="0.8"/>
          </g>
        )}
      </svg>
      {/* CHANGED: Hovered date pinned under the cursor line at the bottom. */}
      {hoverIdx!=null?(
        <div style={{position:"relative",height:14,marginTop:6}}>
          <span style={{position:"absolute",left:((xFor(hoverIdx)/W)*100)+"%",transform:"translateX(-50%)",fontSize:10,color:"#cbd5e1",fontWeight:700,letterSpacing:0.5,whiteSpace:"nowrap"}}>{display.date}</span>
        </div>
      ):(
        <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:10,color:"#64748b",fontWeight:600}}>
          <span>{first.date}</span>
          <span>peak {fmt(peak.v)}</span>
          <span>{last.date}</span>
        </div>
      )}
    </div>
  );
}

function EquityCurve(props){
  var entries=props.entries||[];
  if(entries.length===0)return null;
  // CHANGED: starting balance before the first entry, for % change / % drawdown when $ is hidden.
  var startBal=0;
  try{startBal=getAccountBalanceAtDate(entries[0].date);}catch(e){}
  // CHANGED: When the range is this-week or last-week, plot one point per closed trade (chronologically) instead of per day.
  var granular=props.range==="thisweek"||props.range==="week";
  var pts=[];var cum=0,peak=0,maxDD=0,maxDDPct=0;
  if(granular){
    var allT=[];
    entries.forEach(function(r){(r.trades||[]).forEach(function(t){if(t&&t.status!=="open")allT.push({date:r.date,t:t});});});
    allT.sort(function(a,b){
      var da=new Date(a.date).getTime(),db=new Date(b.date).getTime();
      if(da!==db)return da-db;
      var ma=parseTimeToMinsOfDay(a.t.time)||0;
      var mb=parseTimeToMinsOfDay(b.t.time)||0;
      return ma-mb;
    });
    allT.forEach(function(x){
      cum+=parseFloat(x.t.pnl)||0;
      if(cum>peak)peak=cum;
      var dd=cum-peak;if(dd<maxDD)maxDD=dd;
      var peakEq=startBal+peak;var ddPct=peakEq>0?(dd/peakEq*100):0;
      if(ddPct<maxDDPct)maxDDPct=ddPct;
      pts.push({date:x.date,cum:cum,peak:peak});
    });
    // CHANGED: If granular mode found no trades (e.g. legacy entries with empty trades but valid pnl),
    // fall back to day-level cumulative from r.pnl instead of disappearing.
    if(pts.length===0){
      cum=0;peak=0;maxDD=0;maxDDPct=0;
      entries.forEach(function(r){
        cum+=parseFloat(r.pnl)||0;
        if(cum>peak)peak=cum;
        var dd=cum-peak;if(dd<maxDD)maxDD=dd;
        var peakEq2=startBal+peak;var ddPct2=peakEq2>0?(dd/peakEq2*100):0;
        if(ddPct2<maxDDPct)maxDDPct=ddPct2;
        pts.push({date:r.date,cum:cum,peak:peak});
      });
    }
  }else{
    entries.forEach(function(r){
      cum+=parseFloat(r.pnl)||0;
      if(cum>peak)peak=cum;
      var dd=cum-peak;
      if(dd<maxDD)maxDD=dd;
      // drawdown % relative to peak equity (start balance + peak P&L)
      var peakEq=startBal+peak;
      var ddPct=peakEq>0?(dd/peakEq*100):0;
      if(ddPct<maxDDPct)maxDDPct=ddPct;
      pts.push({date:r.date,cum:cum,peak:peak});
    });
  }
  var W=320,H=80,padX=4,padY=6;
  var maxV=Math.max.apply(null,pts.map(function(p){return p.peak;}).concat([0]));
  var minV=Math.min.apply(null,pts.map(function(p){return p.cum;}).concat([0]));
  if(maxV===minV){maxV+=1;minV-=1;}
  function xFor(i){return padX+(pts.length<=1?W/2:(i/(pts.length-1))*(W-padX*2));}
  function yFor(v){return H-padY-((v-minV)/(maxV-minV))*(H-padY*2);}
  var areaPath=pts.map(function(p,i){return (i===0?"M":"L")+xFor(i).toFixed(1)+","+yFor(p.cum).toFixed(1);}).join("")+"L"+xFor(pts.length-1).toFixed(1)+","+yFor(0).toFixed(1)+"L"+xFor(0).toFixed(1)+","+yFor(0).toFixed(1)+"Z";
  var linePath=pts.map(function(p,i){return (i===0?"M":"L")+xFor(i).toFixed(1)+","+yFor(p.cum).toFixed(1);}).join("");
  var peakPath=pts.map(function(p,i){return (i===0?"M":"L")+xFor(i).toFixed(1)+","+yFor(p.peak).toFixed(1);}).join("");
  // CHANGED: When $ is hidden, equity is expressed as % return. Denominator = starting balance
  // at the range's first entry. If that's 0 (e.g. the user's first deposit lands on the same day
  // as their first entry), fall back to total lifetime deposits so the % is still meaningful
  // instead of collapsing to 0.00%.
  var pctDenom=startBal;
  if(!(pctDenom>0)){
    try{
      var dep=0;
      (loadTransfers()||[]).forEach(function(tf){var a=parseFloat(tf.amount)||0;if(a>0)dep+=a;});
      if(dep>0)pctDenom=dep;
    }catch(e){}
  }
  var positive=cum>=0;
  var fmt=function(n){if(HIDE_DOLLAR_PNL){var pct=pctDenom>0?(n/pctDenom*100):0;return (pct>=0?"+":"")+pct.toFixed(2)+"%";}return (n>=0?"+":"-")+"$"+Math.abs(n).toFixed(2);};
  // CHANGED: Drawdown also reframed to use the same denominator so it's apples-to-apples with the headline %.
  var fmtDD=function(){if(maxDD>=0)return "—";if(HIDE_DOLLAR_PNL){var pct=pctDenom>0?(maxDD/pctDenom*100):maxDDPct;return pct.toFixed(2)+"%";}return fmt(maxDD);};
  // CHANGED: Interactive hover/drag — readout switches to the value at the hovered point.
  var [hoverIdx,setHoverIdx]=useState(null);
  var svgRef=React.useRef(null);
  function handleMove(e){
    if(!svgRef.current)return;
    var rect=svgRef.current.getBoundingClientRect();
    var clientX=e.touches?e.touches[0].clientX:e.clientX;
    var x=clientX-rect.left;
    var ratio=Math.max(0,Math.min(1,x/rect.width));
    var idx=Math.round(ratio*(pts.length-1));
    if(idx<0)idx=0;if(idx>pts.length-1)idx=pts.length-1;
    setHoverIdx(idx);
  }
  function handleLeave(){setHoverIdx(null);}
  var display=hoverIdx!=null?pts[hoverIdx]:null;
  var displayVal=display?display.cum:cum;
  var displayDate=display?display.date:null;
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"#0d0d12",border:"1px solid #1e293b",borderRadius:10,display:"flex",flexDirection:"column",height:"100%",boxSizing:"border-box"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8,gap:8}}>
        <div>
          {/* CHANGED: Date is now rendered at the bottom of the chart under the cursor line, not above the readout. */}
          <div style={{fontSize:20,fontWeight:700,color:displayVal>=0?"#22c55e":"#ef4444",fontVariantNumeric:"tabular-nums"}}>{fmt(displayVal)}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Max Drawdown</div>
          <div style={{fontSize:13,fontWeight:700,color:"#ef4444",marginTop:4,fontVariantNumeric:"tabular-nums"}}>{fmtDD()}</div>
        </div>
      </div>
      <svg ref={svgRef} viewBox={"0 0 "+W+" "+H} style={{display:"block",width:"100%",height:"100%",flex:1,minHeight:120,touchAction:"none",cursor:"crosshair"}} preserveAspectRatio="none" onMouseMove={handleMove} onMouseLeave={handleLeave} onTouchStart={handleMove} onTouchMove={handleMove} onTouchEnd={handleLeave}>
        <line x1={padX} x2={W-padX} y1={yFor(0)} y2={yFor(0)} stroke="#334155" strokeWidth="0.5" strokeDasharray="2,2"/>
        <path d={areaPath} fill={positive?"#22c55e22":"#ef444422"} stroke="none"/>
        {/* CHANGED: Peak line removed; the peak value is still shown in the readout text. */}
        <path d={linePath} fill="none" stroke={positive?"#22c55e":"#ef4444"} strokeWidth="1.5"/>
        {hoverIdx!=null&&(
          <g>
            <line x1={xFor(hoverIdx)} x2={xFor(hoverIdx)} y1={padY} y2={H-padY} stroke="#cbd5e1" strokeWidth="0.6" strokeDasharray="2,2"/>
            <circle cx={xFor(hoverIdx)} cy={yFor(pts[hoverIdx].cum)} r="2.5" fill={pts[hoverIdx].cum>=0?"#22c55e":"#ef4444"} stroke="#fff" strokeWidth="0.8"/>
          </g>
        )}
      </svg>
      {/* CHANGED: Bottom row — when hovering, replace start/peak/end with a single centered date
         pinned to the cursor column, so the reader's eye stays on the cursor instead of darting
         up to a top-corner label. */}
      {hoverIdx!=null?(
        <div style={{position:"relative",height:14,marginTop:6}}>
          <span style={{position:"absolute",left:((xFor(hoverIdx)/W)*100)+"%",transform:"translateX(-50%)",fontSize:10,color:"#cbd5e1",fontWeight:700,letterSpacing:0.5,whiteSpace:"nowrap"}}>{displayDate}</span>
        </div>
      ):(
        <div style={{display:"flex",justifyContent:"space-between",marginTop:6,fontSize:10,color:"#64748b",fontWeight:600}}>
          <span>{entries[0].date}</span>
          <span>peak {fmt(peak)}</span>
          <span>{entries[entries.length-1].date}</span>
        </div>
      )}
    </div>
  );
}

// CHANGED: What's Working / What's Hurting — auto-detects setups (or asset-class+setup combos) with
// the highest and lowest expectancy and highlights the top 3 of each so the user can immediately see
// where to lean in and where to cut.
function WhatsWorkingPanel(props){
  var trades=props.trades||[];
  if(trades.length<5)return null; // not enough data to be meaningful
  // Group by setup. Falls back to asset class when setup is blank.
  var groups={};
  trades.forEach(function(t){
    var key=(t.setup||"").trim()||((t.assetClass?ASSET_CLASSES[t.assetClass]?ASSET_CLASSES[t.assetClass].label:t.assetClass:"")+" (no setup)").trim();
    if(!key)key="Untagged";
    if(!groups[key])groups[key]={n:0,wins:0,losses:0,pnl:0,pctSum:0,pctN:0};
    var p=parseFloat(t.pnl)||0;
    groups[key].n++;
    groups[key].pnl+=p;
    var pc=parseFloat(t.pctPnl);if(!isNaN(pc)){groups[key].pctSum+=pc;groups[key].pctN++;}
    if(p>0)groups[key].wins++;else if(p<0)groups[key].losses++;
  });
  // Compute expectancy (avg pnl per trade). Require ≥3 trades for stability.
  var rows=Object.keys(groups).map(function(k){var g=groups[k];return {key:k,n:g.n,exp:g.pnl/g.n,expPct:g.pctN>0?g.pctSum/g.pctN:0,pnl:g.pnl,wr:g.n>0?Math.round((g.wins/g.n)*100):0};}).filter(function(r){return r.n>=3;});
  if(rows.length===0)return null;
  var working=rows.filter(function(r){return r.exp>0;}).sort(function(a,b){return b.exp-a.exp;}).slice(0,3);
  var hurting=rows.filter(function(r){return r.exp<0;}).sort(function(a,b){return a.exp-b.exp;}).slice(0,3);
  // CHANGED: when $ is hidden, expectancy is shown as average % per trade.
  var fmtExp=function(r){if(HIDE_DOLLAR_PNL)return (r.expPct>=0?"+":"")+r.expPct.toFixed(2)+"%";return (r.exp>=0?"+":"-")+"$"+Math.abs(r.exp).toFixed(0);};
  function Col(p){return (
    <div style={{flex:1,minWidth:0,padding:"10px 12px",background:"#0d0d12",border:"1px solid "+p.bd,borderRadius:8,display:"flex",flexDirection:"column"}}>
      <div style={{fontSize:10,color:p.titleColor,letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:6,display:"flex",alignItems:"center",gap:6}}><span>{p.icon}</span>{p.title}</div>
      {p.items.length===0?(
        <div style={{fontSize:11,color:"#64748b",fontStyle:"italic",padding:"4px 0"}}>{p.empty}</div>
      ):p.items.map(function(r,i){return (
        <div key={r.key} style={{padding:"5px 0",borderBottom:i<p.items.length-1?"1px solid #1e293b":"none"}}>
          <div style={{fontSize:12,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.key}</div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginTop:2,gap:6}}>
            <span style={{fontSize:10,color:"#64748b"}}>{r.n} · {r.wr}% wr</span>
            <span style={{fontSize:12,fontWeight:700,color:p.valColor,fontVariantNumeric:"tabular-nums"}}>{fmtExp(r)}<span style={{fontSize:9,color:"#475569",fontWeight:400}}>/trade</span></span>
          </div>
        </div>
      );})}
    </div>
  );}
  return (
    <div style={{display:"flex",gap:8,marginBottom:12,height:"100%",boxSizing:"border-box",alignItems:"stretch"}}>
      <Col title="What's Working" icon="▲" bd="#16653466" titleColor="#86efac" valColor="#22c55e" items={working} empty="No positive setups yet"/>
      <Col title="What's Hurting" icon="▼" bd="#7f1d1d66" titleColor="#fca5a5" valColor="#ef4444" items={hurting} empty="Nothing flagged — clean run"/>
    </div>
  );
}

// CHANGED: R-multiple distribution — the single most diagnostic chart for whether an edge exists.
// Each trade is converted to R = pnl / planned_risk, where planned_risk is the journal row's
// riskMax × the trade's sizeFraction (falls back to current settings if a row predates the field).
// Buckets are <-3R, -3..-2, -2..-1, -1..0, 0..1, 1..2, 2..3, ≥3R. Avg-R and expectancy shown above.
function RMultipleHistogram(props){
  var rows=props.rows||[],fallback=props.fallbackRiskMax||0;
  var Rs=[];
  rows.forEach(function(r){
    var rowRisk=parseFloat(r.riskMax)||fallback;
    (r.trades||[]).forEach(function(t){
      if(!t||t.status==="open")return;
      var pnl=parseFloat(t.pnl);if(isNaN(pnl))return;
      var sf=parseFloat(t.sizeFraction);if(isNaN(sf)||sf<=0)sf=1;
      var risk=rowRisk*sf;
      if(risk<=0)return;
      Rs.push(pnl/risk);
    });
  });
  if(Rs.length<3)return null;
  var bounds=[-Infinity,-3,-2,-1,0,1,2,3,Infinity];
  var labels=["<-3R","-3 to -2","-2 to -1","-1 to 0","0 to 1","1 to 2","2 to 3","≥3R"];
  var counts=labels.map(function(){return 0;});
  Rs.forEach(function(r){
    for(var i=0;i<labels.length;i++){
      if(r>=bounds[i]&&r<bounds[i+1]){counts[i]++;break;}
    }
  });
  var maxCount=Math.max.apply(null,counts);
  var avgR=Rs.reduce(function(s,v){return s+v;},0)/Rs.length;
  // Expectancy in R terms = wr*avgWinR - lr*|avgLossR|
  var winsR=Rs.filter(function(r){return r>0;}),lossesR=Rs.filter(function(r){return r<0;});
  var wr=winsR.length/Rs.length;
  var avgWinR=winsR.length>0?winsR.reduce(function(s,v){return s+v;},0)/winsR.length:0;
  var avgLossR=lossesR.length>0?lossesR.reduce(function(s,v){return s+v;},0)/lossesR.length:0;
  var expR=avgR; // expectancy per trade in R, same thing as avgR
  // CHANGED: Hover/drag — bucket under cursor is highlighted and the headline switches to that bucket's count and % share.
  var [hoverI,setHoverI]=useState(null);
  var barsRef=React.useRef(null);
  function moveBars(e){
    if(!barsRef.current)return;
    var rect=barsRef.current.getBoundingClientRect();
    var clientX=e.touches?e.touches[0].clientX:e.clientX;
    var x=clientX-rect.left;
    var ratio=Math.max(0,Math.min(0.9999,x/rect.width));
    setHoverI(Math.floor(ratio*labels.length));
  }
  function leaveBars(){setHoverI(null);}
  var hoverCount=hoverI!=null?counts[hoverI]:null;
  var hoverPct=hoverI!=null&&Rs.length>0?Math.round((counts[hoverI]/Rs.length)*100):null;
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"#0d0d12",border:"1px solid #1e293b",borderRadius:10,display:"flex",flexDirection:"column",boxSizing:"border-box"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,gap:8}}>
        <div>
          <div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>{hoverI!=null?labels[hoverI]:"R-Multiple Distribution"}</div>
          {hoverI!=null?(
            <div style={{fontSize:20,fontWeight:700,color:bounds[hoverI+1]<=0?"#ef4444":"#22c55e",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{hoverCount}<span style={{fontSize:10,color:"#94a3b8",fontWeight:500,marginLeft:4}}>trade{hoverCount===1?"":"s"} · {hoverPct}%</span></div>
          ):(
            <div style={{fontSize:20,fontWeight:700,color:expR>=0?"#22c55e":"#ef4444",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{(expR>=0?"+":"")+expR.toFixed(2)}R<span style={{fontSize:10,color:"#94a3b8",fontWeight:500,marginLeft:4}}>/trade</span></div>
          )}
        </div>
        <div style={{textAlign:"right",fontSize:10,color:"#94a3b8",lineHeight:1.55}}>
          <div>Avg win: <span style={{color:"#86efac",fontWeight:700}}>+{avgWinR.toFixed(2)}R</span></div>
          <div>Avg loss: <span style={{color:"#fca5a5",fontWeight:700}}>{avgLossR.toFixed(2)}R</span></div>
          <div>n = {Rs.length}</div>
        </div>
      </div>
      <div ref={barsRef} onMouseMove={moveBars} onMouseLeave={leaveBars} onTouchStart={moveBars} onTouchMove={moveBars} onTouchEnd={leaveBars} style={{display:"flex",alignItems:"flex-end",gap:3,height:120,marginBottom:6,cursor:"crosshair",touchAction:"none"}}>
        {counts.map(function(c,i){
          var h=maxCount>0?(c/maxCount)*100:0;
          var isNeg=bounds[i+1]<=0;
          var color=isNeg?"#ef4444":"#22c55e";
          var isHover=hoverI===i;
          return (
            <div key={i} style={{flex:1,height:"100%",display:"flex",flexDirection:"column",justifyContent:"flex-end",alignItems:"center",position:"relative"}}>
              {c>0&&<div style={{position:"absolute",top:-2,transform:"translateY(-100%)",fontSize:9,color:isHover?"#fff":"#94a3b8",fontWeight:700,fontVariantNumeric:"tabular-nums"}}>{c}</div>}
              <div style={{width:"100%",height:Math.max(c>0?4:0,h)+"%",background:color,opacity:isHover?1:(c>0?0.85:0.2),borderRadius:"3px 3px 0 0",transition:"opacity 0.15s"}}/>
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:3}}>
        {labels.map(function(l,i){return <div key={i} style={{flex:1,textAlign:"center",fontSize:8,color:hoverI===i?"#cbd5e1":"#64748b",fontWeight:600,letterSpacing:0.2}}>{l}</div>;})}
      </div>
    </div>
  );
}

// CHANGED: Discipline × Performance scatter — each dot is one trading day. X = daily discipline
// score, Y = daily P&L. A reference vertical line marks the user's lock threshold so it's instantly
// clear whether days under-threshold cluster in the red zone. Hover/drag shows the day's date and
// P&L in the readout.
function DisciplineScatter(props){
  var rows=props.rows||[],settings=props.settings||{};
  // CHANGED: When viewing this-week / last-week, plot one point per closed trade so individual
  // trades can be inspected. Score for a trade is the day's process score taken AT that trade
  // (cumulative through that trade in chronological order). P&L is the trade's own P&L.
  var granular=props.range==="thisweek"||props.range==="week";
  var pts=[];
  if(granular){
    rows.forEach(function(r){
      var trades=(r.trades||[]).filter(function(t){return t&&t.status!=="open";});
      if(trades.length===0)return;
      var sorted=trades.slice().sort(function(a,b){var ma=parseTimeToMinsOfDay(a.time)||0;var mb=parseTimeToMinsOfDay(b.time)||0;return ma-mb;});
      var sb=0;try{sb=getAccountBalanceAtDate(r.date);}catch(e){}
      sorted.forEach(function(t,i){
        var slice=sorted.slice(0,i+1);
        // Use process-only score so each trade's "discipline so far today" is reflected.
        var score=calcDiscipline(slice,parseFloat(r.riskMax)||0,{processOnly:true,commitment:r.commitment||null});
        var pnl=parseFloat(t.pnl)||0;
        var rm=parseFloat(r.riskMax)||0;
        pts.push({date:r.date,score:score,pnl:pnl,pct:sb>0?(pnl/sb*100):0,r:rm>0?(pnl/rm):0,n:1});
      });
    });
  }else{
    rows.forEach(function(r){
      var trades=(r.trades||[]).filter(function(t){return t&&t.status!=="open";});
      if(trades.length===0)return;
      var score=parseFloat(r.disciplineScore);
      if(isNaN(score))score=calcDiscipline(trades,parseFloat(r.riskMax)||0);
      var dayPnl=parseFloat(r.pnl)||0;
      var sb=0;try{sb=getAccountBalanceAtDate(r.date);}catch(e){}
      var rm=parseFloat(r.riskMax)||0;
      pts.push({date:r.date,score:score,pnl:dayPnl,pct:sb>0?(dayPnl/sb*100):0,r:rm>0?(dayPnl/rm):0,n:trades.length});
    });
  }
  if(pts.length<3)return null;
  var thr=loadDisciplineLockThreshold();
  var W=320,H=120,padL=34,padR=8,padT=10,padB=18;
  // CHANGED: Y-axis now plots R-multiple instead of raw $ / %. Each point's r = pnl / riskMax.
  var rs=pts.map(function(p){return p.r;});
  var maxR=Math.max.apply(null,rs.concat([0]));
  var minR=Math.min.apply(null,rs.concat([0]));
  if(maxR===minR){maxR+=1;minR-=1;}
  function xFor(s){return padL+(s/100)*(W-padL-padR);}
  function yFor(v){return padT+(1-(v-minR)/(maxR-minR))*(H-padT-padB);}
  // Correlation between score and R — Pearson r.
  function corr(){
    var n=pts.length;
    var sx=0,sy=0;pts.forEach(function(p){sx+=p.score;sy+=p.r;});
    var mx=sx/n,my=sy/n,num=0,dx=0,dy=0;
    pts.forEach(function(p){var a=p.score-mx,b=p.r-my;num+=a*b;dx+=a*a;dy+=b*b;});
    if(dx===0||dy===0)return 0;
    return num/Math.sqrt(dx*dy);
  }
  var r=corr();
  // Aggregate stats above/below threshold for the side readout — averaged in R.
  var below=pts.filter(function(p){return p.score<thr;}),above=pts.filter(function(p){return p.score>=thr;});
  var belowAvgR=below.length>0?below.reduce(function(s,p){return s+(p.r||0);},0)/below.length:0;
  var aboveAvgR=above.length>0?above.reduce(function(s,p){return s+(p.r||0);},0)/above.length:0;
  // CHANGED: All point labels now use R-multiple instead of $ / %.
  var fmtR=function(v){return (v>=0?"+":"")+v.toFixed(2)+"R";};
  var [hover,setHover]=useState(null);
  var svgRef=React.useRef(null);
  function onMove(e){
    if(!svgRef.current)return;
    var rect=svgRef.current.getBoundingClientRect();
    var clientX=e.touches?e.touches[0].clientX:e.clientX;
    var clientY=e.touches?e.touches[0].clientY:e.clientY;
    var x=((clientX-rect.left)/rect.width)*W;
    var y=((clientY-rect.top)/rect.height)*H;
    // Find nearest point.
    var best=null,bestD=Infinity;
    pts.forEach(function(p,i){
      var dx=xFor(p.score)-x,dy=yFor(p.r)-y;
      var d=dx*dx+dy*dy;
      if(d<bestD){bestD=d;best=i;}
    });
    if(best!=null&&bestD<400)setHover(best);else setHover(null);
  }
  function onLeave(){setHover(null);}
  // CHANGED: SVG-level click — navigate to the date of the currently hovered (nearest) point.
  // This widens the click target far beyond the tiny circle (any click within ~20px of a point hits).
  function onSvgClick(){if(hover!=null&&props.onNavigateToTrade){var p=pts[hover];if(p&&p.date)props.onNavigateToTrade(p.date);}}
  var hp=hover!=null?pts[hover]:null;
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"#0d0d12",border:"1px solid #1e293b",borderRadius:10,display:"flex",flexDirection:"column",height:"100%",boxSizing:"border-box"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,gap:8}}>
        <div>
          {/* CHANGED: Top-left stays on the static summary; the hovered-date label is rendered
             next to the dot itself inside the SVG (see <text> below) so the eye stays put. */}
          <div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>{hp?("R · score "+Math.round(hp.score)):"Discipline × Performance"}</div>
          {hp?(
            <div style={{fontSize:20,fontWeight:700,color:hp.r>=0?"#22c55e":"#ef4444",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{fmtR(hp.r)}<span style={{fontSize:10,color:"#94a3b8",fontWeight:500,marginLeft:6}}>{hp.n}t</span></div>
          ):(
            <div style={{fontSize:20,fontWeight:700,color:pts.length<30?"#475569":(r<-0.2?"#22c55e":r>0.2?"#ef4444":"#94a3b8"),marginTop:2,fontVariantNumeric:"tabular-nums"}}>r = {r.toFixed(2)}<span style={{fontSize:10,color:pts.length<30?"#64748b":"#94a3b8",fontWeight:500,marginLeft:6,fontStyle:pts.length<30?"italic":"normal"}}>{pts.length<30?("low sample · "+pts.length+"/30"):(Math.abs(r)<0.2?"weak":Math.abs(r)<0.5?"moderate":"strong")+" link"}</span></div>
          )}
        </div>
        <div style={{textAlign:"right",fontSize:10,color:"#94a3b8",lineHeight:1.55}}>
          <div>Below thr ({below.length}): <span style={{color:belowAvgR>=0?"#86efac":"#fca5a5",fontWeight:700}}>{fmtR(belowAvgR)}</span></div>
          <div>At/above ({above.length}): <span style={{color:aboveAvgR>=0?"#86efac":"#fca5a5",fontWeight:700}}>{fmtR(aboveAvgR)}</span></div>
        </div>
      </div>
      <svg ref={svgRef} viewBox={"0 0 "+W+" "+H} style={{display:"block",width:"100%",height:"100%",flex:1,minHeight:120,cursor:hover!=null&&props.onNavigateToTrade?"pointer":"crosshair",touchAction:"none"}} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={onLeave} onTouchStart={onMove} onTouchMove={onMove} onTouchEnd={onLeave} onClick={onSvgClick}>
        {/* Y=0 line */}
        <line x1={padL} x2={W-padR} y1={yFor(0)} y2={yFor(0)} stroke="#334155" strokeWidth="0.5" strokeDasharray="2,2"/>
        {/* Threshold vertical line */}
        <line x1={xFor(thr)} x2={xFor(thr)} y1={padT} y2={H-padB} stroke="#ef4444" strokeWidth="0.6" strokeDasharray="2,2"/>
        <text x={xFor(thr)} y={padT-2} fontSize="7" fill="#ef4444" textAnchor="middle" fontWeight="700">thr {thr}</text>
        {/* X-axis labels */}
        {[0,25,50,75,100].map(function(v){return <text key={v} x={xFor(v)} y={H-5} fontSize="7" fill="#64748b" textAnchor="middle">{v}</text>;})}
        <text x={padL-3} y={yFor(0)+2} fontSize="7" fill="#64748b" textAnchor="end">0</text>
        <text x={padL-3} y={yFor(maxR)+3} fontSize="7" fill="#64748b" textAnchor="end">{fmtR(maxR)}</text>
        <text x={padL-3} y={yFor(minR)} fontSize="7" fill="#64748b" textAnchor="end">{fmtR(minR)}</text>
        {/* Dots */}
        {pts.map(function(p,i){
          var col=p.r>=0?"#22c55e":"#ef4444";
          var isH=hover===i;
          // CHANGED: Click a dot to jump to that date in the Journal.
          return <circle key={i} cx={xFor(p.score)} cy={yFor(p.r)} r={isH?4:2.5} fill={col} opacity={hover==null||isH?0.95:0.5} stroke={isH?"#fff":"none"} strokeWidth="0.6" style={{cursor:props.onNavigateToTrade?"pointer":"default"}} onClick={function(){if(props.onNavigateToTrade&&p.date)props.onNavigateToTrade(p.date);}}/>;
        })}
        {/* CHANGED: Floating date label next to the hovered dot — pinned to the dot's position
           so the user sees the date right where their cursor already is. Offset above the dot,
           or below if the dot is near the top edge. */}
        {hp&&(function(){
          var cx=xFor(hp.score);
          var cy=yFor(hp.r);
          var above=cy>(padT+12);
          var ty=above?(cy-7):(cy+12);
          var anchor=cx>(W-padR-30)?"end":(cx<(padL+30)?"start":"middle");
          return <text x={cx} y={ty} fontSize="8" fontWeight="700" fill="#cbd5e1" textAnchor={anchor} style={{pointerEvents:"none"}}>{hp.date}</text>;
        })()}
      </svg>
      {/* CHANGED: Brief explanation of the headline correlation (r). */}
      <div style={{fontSize:10,color:"#64748b",fontStyle:"italic",marginTop:6,lineHeight:1.4}}>r is the correlation between discipline score and R-multiple. Positive r means higher discipline pairs with higher R; negative means they diverge.</div>
    </div>
  );
}

// CHANGED: Streak tracker — current streak (last consecutive run of same-sign days), longest
// winning streak, longest losing streak, longest discipline streak (≥ threshold). Pure day-level
// computation across the filtered range.
function StreakTracker(props){
  var rows=(props.rows||[]).slice();
  // CHANGED: Count days that either have closed trades OR a non-zero stored pnl (covers legacy
  // entries whose trades array was emptied but whose pnl snapshot is intact).
  rows=rows.filter(function(r){return (r.trades||[]).some(function(t){return t&&t.status!=="open";})||((parseFloat(r.pnl)||0)!==0);});
  if(rows.length<2)return null;
  // Sort ascending by date (already sorted earlier, but be defensive).
  rows.sort(function(a,b){return new Date(a.date)-new Date(b.date);});
  var thr=loadDisciplineLockThreshold();
  function discScore(r){var s=parseFloat(r.disciplineScore);if(!isNaN(s))return s;return calcDiscipline((r.trades||[]).filter(function(t){return t&&t.status!=="open";}),parseFloat(r.riskMax)||0);}
  var bestWin=0,bestLose=0,bestDisc=0;
  var cw=0,cl=0,cd=0;
  rows.forEach(function(r){
    var pnl=parseFloat(r.pnl)||0;
    if(pnl>0){cw++;cl=0;}else if(pnl<0){cl++;cw=0;}else{cw=0;cl=0;}
    if(cw>bestWin)bestWin=cw;if(cl>bestLose)bestLose=cl;
    if(discScore(r)>=thr){cd++;if(cd>bestDisc)bestDisc=cd;}else cd=0;
  });
  // Current streak: walk backwards.
  var curN=0,curKind="flat";
  for(var i=rows.length-1;i>=0;i--){
    var pnl=parseFloat(rows[i].pnl)||0;
    if(i===rows.length-1){if(pnl>0){curKind="win";curN=1;}else if(pnl<0){curKind="lose";curN=1;}else{curKind="flat";break;}continue;}
    if(curKind==="win"&&pnl>0)curN++;
    else if(curKind==="lose"&&pnl<0)curN++;
    else break;
  }
  function Card(p){return (
    <div style={{flex:1,minWidth:0,padding:"8px 10px",background:"#0a0a0f",border:"1px solid "+p.bd,borderRadius:6,display:"flex",flexDirection:"column",justifyContent:"center"}}>
      <div style={{fontSize:9,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.label}</div>
      <div style={{fontSize:18,fontWeight:700,color:p.color,marginTop:2,fontVariantNumeric:"tabular-nums"}}>{p.value}<span style={{fontSize:9,color:"#94a3b8",fontWeight:500,marginLeft:3}}>{p.unit}</span></div>
    </div>
  );}
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"#0d0d12",border:"1px solid #1e293b",borderRadius:10,display:"flex",flexDirection:"column",boxSizing:"border-box",alignSelf:"start"}}>
      <div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600,marginBottom:8}}>Streaks</div>
      <div style={{display:"flex",gap:6,alignItems:"stretch"}}>
        <Card label="Current" value={curN} unit={curKind==="win"?"green":curKind==="lose"?"red":"—"} color={curKind==="win"?"#22c55e":curKind==="lose"?"#ef4444":"#94a3b8"} bd={curKind==="win"?"#16653466":curKind==="lose"?"#7f1d1d66":"#334155"}/>
        <Card label="Best Win" value={bestWin} unit="days" color="#22c55e" bd="#16653466"/>
        <Card label="Worst Loss" value={bestLose} unit="days" color="#ef4444" bd="#7f1d1d66"/>
        <Card label="Discipline" value={bestDisc} unit="≥thr" color="#a5b4fc" bd="#4338ca66"/>
      </div>
    </div>
  );
}

// CHANGED: Session × Day-of-Week heatmap — rows are configured sessions, cols are Mon–Fri. Cell
// color/intensity reflects total P&L for that intersection. Click cells to inspect. Helps surface
// strong/weak slots that are otherwise buried in per-trade noise.
function SessionDayHeatmap(props){
  var rows=props.rows||[],settings=props.settings||{};
  var sessions=getSessions(settings).filter(function(s){return s.enabled!==false;});
  if(sessions.length===0)return null;
  var dayLabels=["Mon","Tue","Wed","Thu","Fri"];
  var dayNums=[1,2,3,4,5];
  // grid[sessionIdx][dayIdx] = {pnl,n,wins,rSum}
  var grid=sessions.map(function(){return dayLabels.map(function(){return {pnl:0,n:0,wins:0,rSum:0};});});
  var fallbackRisk=parseFloat(settings.riskMax)||0;
  var totalTrades=0;
  rows.forEach(function(r){
    var d=new Date(r.date);if(isNaN(d.getTime()))return;
    var di=dayNums.indexOf(d.getDay());if(di<0)return;
    var rRisk=parseFloat(r.riskMax)||fallbackRisk;
    (r.trades||[]).forEach(function(t){
      if(!t||t.status==="open")return;
      var sidx=sessions.findIndex(function(s){return s.id===t.sessionId;});
      if(sidx<0)return;
      var pnl=parseFloat(t.pnl)||0;
      grid[sidx][di].pnl+=pnl;
      grid[sidx][di].n++;
      if(pnl>0)grid[sidx][di].wins++;
      if(rRisk>0)grid[sidx][di].rSum+=pnl/rRisk;
      totalTrades++;
    });
  });
  if(totalTrades<3)return null;
  // Find max absolute pnl for color intensity.
  var maxAbs=0;
  grid.forEach(function(row){row.forEach(function(c){if(Math.abs(c.pnl)>maxAbs)maxAbs=Math.abs(c.pnl);});});
  if(maxAbs===0)maxAbs=1;
  var [hover,setHover]=useState(null);
  var fmt=function(n){if(HIDE_DOLLAR_PNL)return (n>=0?"+":"-")+"$•••";return (n>=0?"+":"-")+"$"+Math.abs(n).toFixed(0);};
  var hp=hover?{s:sessions[hover.s],d:dayLabels[hover.d],c:grid[hover.s][hover.d]}:null;
  return (
    <div style={{marginBottom:12,padding:"12px 14px",background:"#0d0d12",border:"1px solid #1e293b",borderRadius:10,display:"flex",flexDirection:"column",height:"100%",boxSizing:"border-box"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10,gap:8}}>
        <div>
          <div style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>{hp?(hp.s.name+" · "+hp.d):"Session × Day (WR)"}</div>
          {hp?(
            <div style={{fontSize:18,fontWeight:700,color:hp.c.n>0?(hp.c.wins/hp.c.n>=0.5?"#22c55e":"#ef4444"):"#94a3b8",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{hp.c.n>0?Math.round(hp.c.wins/hp.c.n*100):0}% wr<span style={{fontSize:10,color:"#94a3b8",fontWeight:500,marginLeft:6}}>{hp.c.n}t · {HIDE_DOLLAR_PNL?((hp.c.n>0?((hp.c.rSum/hp.c.n>=0?"+":"")+(hp.c.rSum/hp.c.n).toFixed(2)):"0.00")+"R"):fmt(hp.c.pnl)}</span></div>
          ):(
            <div style={{fontSize:14,fontWeight:600,color:"#94a3b8",marginTop:2}}>Tap a cell to inspect</div>
          )}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,84px) repeat(5,minmax(0,1fr))",gap:4,flex:1,alignContent:"center"}}>
        <div/>
        {dayLabels.map(function(d,i){return <div key={i} style={{fontSize:9,color:"#64748b",fontWeight:700,textAlign:"center",letterSpacing:0.5,textTransform:"uppercase"}}>{d}</div>;})}
        {sessions.map(function(s,si){
          var children=[<div key={"l"+si} style={{fontSize:10,color:"#cbd5e1",fontWeight:600,display:"flex",alignItems:"center",paddingRight:4,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={s.name}>{s.name}</div>];
          dayLabels.forEach(function(d,di){
            var c=grid[si][di];
            var isHover=hover&&hover.s===si&&hover.d===di;
            // CHANGED: Color intensity now driven by WIN RATE distance from 50%, not P&L magnitude.
            // 50% wr → neutral; 100% → full green; 0% → full red. Sample size still gates display.
            var wr=c.n>0?(c.wins/c.n):0.5;
            var dev=Math.abs(wr-0.5)*2; // 0 at 50%, 1 at 0% or 100%
            var alpha=c.n===0?0:Math.max(0.18,dev);
            var bg=c.n===0?"#0a0a0f":(wr>=0.5?"rgba(34,197,94,"+alpha+")":"rgba(239,68,68,"+alpha+")");
            children.push(
              <button key={si+"-"+di} onClick={function(){setHover(isHover?null:{s:si,d:di});}} onMouseEnter={function(){if(c.n>0)setHover({s:si,d:di});}} onMouseLeave={function(){setHover(null);}} style={{height:36,background:bg,border:isHover?"1.5px solid #fff":"1px solid "+(c.n===0?"#1e293b":"#334155"),borderRadius:4,cursor:c.n>0?"pointer":"default",fontFamily:"inherit",padding:0,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                {c.n>0&&<span style={{fontSize:11,fontWeight:700,color:"#fff",fontVariantNumeric:"tabular-nums",textShadow:"0 1px 2px rgba(0,0,0,0.6)",lineHeight:1}}>{Math.round(c.wins/c.n*100)}%</span>}
              </button>
            );
          });
          return children;
        })}
      </div>
    </div>
  );
}

// CHANGED: Achievements extracted from the Home progress widget to live on the Performance tab.
function AchievementsPanel(){
  var rows=loadJournalRows();
  var streak=calculateStreak(true);
  var withdrawn=getTotalWithdrawn();
  var earned=getEarnedAchievements(rows,streak,withdrawn);
  var data=loadGamificationData();
  var seenIds=data.seenAchievements||[];
  var earnedIds=earned.map(function(a){return a.id;});
  var newIds=earnedIds.filter(function(id){return seenIds.indexOf(id)<0;});
  var [celebration,setCelebration]=useState(null);
  var [open,setOpen]=useState(false);
  useEffect(function(){
    var newOnes=checkNewAchievements(rows,streak,withdrawn);
    if(newOnes.length>0){setCelebration(newOnes[0]);setTimeout(function(){setCelebration(null);},4000);}
  },[]);
  return (
    <div style={CS({marginBottom:16,padding:0,overflow:"hidden"})}>
      {celebration&&(
        <div style={{padding:"10px 14px",background:"#1e1b4b",borderBottom:"1px solid #4338ca",display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:18}}>{celebration.icon}</span>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#a5b4fc"}}>Achievement unlocked: {celebration.name}</div>
            <div style={{fontSize:11,color:"#818cf8"}}>{achDesc(celebration)}</div>
          </div>
        </div>
      )}
      <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",padding:"12px 14px",borderBottom:open?"1px solid #1e293b":"none",display:"flex",justifyContent:"space-between",alignItems:"center",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <div style={{fontSize:13,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Achievements</div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:11,color:"#94a3b8"}}>{earned.length} / {ACHIEVEMENTS.length} 🏆</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
      </button>
      {open&&<div style={{padding:"12px 14px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:8}}>
          {ACHIEVEMENTS.map(function(a){
            var isEarned=earnedIds.indexOf(a.id)>=0;
            var isNew=newIds.indexOf(a.id)>=0;
            return (
              <div key={a.id} style={{background:isEarned?"#0f1f2a":"#0a0a0f",border:"1px solid "+(isEarned?"#166534":"#1e293b"),borderRadius:8,padding:"10px 12px",opacity:isEarned?1:0.45}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                  <span style={{fontSize:18,filter:isEarned?"none":"grayscale(1)"}}>{a.icon}</span>
                  {isNew&&<span style={{fontSize:9,padding:"1px 5px",background:"#4338ca",borderRadius:3,color:"#a5b4fc",fontWeight:700}}>NEW</span>}
                </div>
                <div style={{fontSize:12,fontWeight:700,color:isEarned?"#e2e8f0":"#475569"}}>{a.name}</div>
                <div style={{fontSize:10,color:isEarned?"#64748b":"#334155",marginTop:2,lineHeight:1.35}}>{achDesc(a)}</div>
              </div>
            );
          })}
        </div>
      </div>}
    </div>
  );
}

function PerformanceTab(props){
  var settings=props.settings;
  var [rows,setRows]=useState([]);
  // CHANGED: Persist the time-range selection across tab switches (matches scalingTarget below).
  var [range,setRange]=useState(function(){try{var r=localStorage.getItem("tf-stats-range")||"all";return r==="custom"?"all":r;}catch(e){return "all";}});
  // CHANGED: Selected metric for the combined Overview / chart block. Default = totalPnl (equity curve).
  var [selectedMetric,setSelectedMetric]=useState("totalPnl");
  // CHANGED: Custom mode tracks whether the Custom pill's date inputs are revealed. The actual
  // `range` value stays on the previously-selected preset until the user picks at least one
  // date — so the displayed data doesn't change the moment Custom is tapped.
  var [customMode,setCustomMode]=useState(function(){try{return localStorage.getItem("tf-stats-range")==="custom";}catch(e){return false;}});
  // CHANGED: Custom date range — two ISO date strings persisted across reloads. Defaults to last 14 days.
  var [customStart,setCustomStart]=useState(function(){try{return localStorage.getItem("tf-stats-custom-start")||"";}catch(e){return "";}});
  var [customEnd,setCustomEnd]=useState(function(){try{return localStorage.getItem("tf-stats-custom-end")||"";}catch(e){return "";}});
  useEffect(function(){try{localStorage.setItem("tf-stats-custom-start",customStart||"");localStorage.setItem("tf-stats-custom-end",customEnd||"");}catch(e){}},[customStart,customEnd]);
  useEffect(function(){try{localStorage.setItem("tf-stats-range",range);}catch(e){}},[range]);
  useEffect(function(){setRows(loadJournalRows());},[props.reloadKey]);
  var liveTotalPnL=props.totalPnL||0;
  var todayDateStr=todayStr();
  var allRows=rows.slice();
  if(liveTotalPnL!==0){
    var todayIdx=allRows.findIndex(function(r){return r.date===todayDateStr;});
    if(todayIdx<0){
      var liveTrades=props.state&&props.state.trades?props.state.trades.filter(function(t){return t.status!=="open";}):[];
      var liveWins=liveTrades.filter(function(t){return parseFloat(t.pnl)>0;}).length;
      var liveLosses=liveTrades.filter(function(t){return parseFloat(t.pnl)<0;}).length;
      var liveRiskMax=parseFloat((props.settings&&props.settings.riskMax))||0;
      allRows.push({date:todayDateStr,pnl:liveTotalPnL,trades:liveTrades,wins:liveWins,losses:liveLosses,riskMax:liveRiskMax,disciplineScore:calcDiscipline(liveTrades,liveRiskMax,{commitment:(props.state&&props.state.commitment)||null})});
    }
  }
  // CHANGED: Retroactively assign correct sessionId based on each trade's actual start time.
  // Existing trades saved when the market was closed (sessionId=null) get attributed properly here.
  allRows=allRows.map(function(r){
    if(!r||!r.trades||!r.trades.length)return r;
    var changed=false;
    var fixed=r.trades.map(function(t){
      if(!t)return t;
      var derived=getSessionForTrade(t);
      if(derived&&derived!==t.sessionId){changed=true;return Object.assign({},t,{sessionId:derived});}
      return t;
    });
    return changed?Object.assign({},r,{trades:fixed}):r;
  });
  function inRange(d){
    if(range==="all")return true;
    // CHANGED: Parse as LOCAL midnight regardless of format. ISO strings ("2026-06-07") would
    // otherwise be read as UTC midnight, shifting to the previous local day in negative-UTC
    // timezones and silently dropping yesterday's trades from "This Week".
    var dd;
    if(typeof d==="string"){
      var iso=d.match(/^(\d{4})-(\d{2})-(\d{2})/);
      var sl=d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      var dsh=d.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
      if(iso)dd=new Date(+iso[1],+iso[2]-1,+iso[3]);
      else if(sl)dd=new Date(+sl[3],+sl[1]-1,+sl[2]);
      else if(dsh)dd=new Date(+dsh[3],+dsh[1]-1,+dsh[2]);
      else dd=new Date(d);
    }else dd=new Date(d);
    if(isNaN(dd.getTime()))return false;
    dd.setHours(0,0,0,0);
    var now=getPT();
    // CHANGED: "Last Week" now means the PREVIOUS fixed calendar week (Mon–Sun before the current
    // week), not a rolling 7-day window. A rolling window slides daily and clips a different
    // boundary day each time, which is why a real 5-trading-day week could read as 4. This is a
    // fixed Mon–Fri(+weekend) span, so it shows the same full week regardless of today's weekday.
    // CHANGED: Week boundaries are Sunday-start (Sun–Sat) per user spec.
    if(range==="thisweek"){
      var sunNow=new Date(now);sunNow.setHours(0,0,0,0);
      sunNow.setDate(sunNow.getDate()-sunNow.getDay()); // Sunday of current week, 00:00
      return dd>=sunNow; // Sunday through today
    }
    if(range==="week"){
      var sunThis=new Date(now);sunThis.setHours(0,0,0,0);
      sunThis.setDate(sunThis.getDate()-sunThis.getDay()); // Sunday of CURRENT week, 00:00
      var startPrev=new Date(sunThis);startPrev.setDate(sunThis.getDate()-7); // previous Sunday
      var endPrev=new Date(sunThis);endPrev.setDate(sunThis.getDate()-1);endPrev.setHours(0,0,0,0); // previous Saturday
      return dd>=startPrev&&dd<=endPrev;
    }
    if(range==="mtd"){
      // CHANGED: Month-to-date = first of current month → today.
      var startM=new Date(now.getFullYear(),now.getMonth(),1);startM.setHours(0,0,0,0);
      return dd>=startM;
    }
    if(range==="ytd"){
      // CHANGED: Year-to-date = Jan 1 of current year → today.
      var startY=new Date(now.getFullYear(),0,1);startY.setHours(0,0,0,0);
      return dd>=startY;
    }
    if(range==="custom"){
      // CHANGED: Custom range — bounded by user-picked ISO dates. Missing bound = open-ended on that side.
      if(customStart){
        var sParts=customStart.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if(sParts){var sD=new Date(+sParts[1],+sParts[2]-1,+sParts[3]);sD.setHours(0,0,0,0);if(dd<sD)return false;}
      }
      if(customEnd){
        var eParts=customEnd.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if(eParts){var eD=new Date(+eParts[1],+eParts[2]-1,+eParts[3]);eD.setHours(0,0,0,0);if(dd>eD)return false;}
      }
      return true;
    }
    var cutoff=new Date(now);
    if(range==="month")cutoff.setMonth(now.getMonth()-1);
    else if(range==="3month")cutoff.setMonth(now.getMonth()-3);
    else if(range==="year")cutoff.setFullYear(now.getFullYear()-1);
    cutoff.setHours(0,0,0,0);
    return dd>=cutoff;
  }
  var filtered=allRows.filter(function(r){return inRange(r.date);});
  filtered.sort(function(a,b){return new Date(a.date)-new Date(b.date);});
  var allTrades=[];filtered.forEach(function(r){(r.trades||[]).forEach(function(t){if(t.status!=="open")allTrades.push(t);});});
  // CHANGED: trading day = row with closed trades OR a non-zero stored pnl (covers entries whose
  // trades array was emptied by an older rollover bug but whose saved pnl is still correct).
  var tradingDays=filtered.filter(function(r){return (r.trades||[]).some(function(t){return t.status!=="open";})||((parseFloat(r.pnl)||0)!==0);}).length;
  var avgTradesPerDay=tradingDays>0?(allTrades.length/tradingDays):0;
  // CHANGED: Total P&L = sum of each row's stored pnl (snapshot) so it's accurate even when an
  // entry's trades array is empty/corrupted but its pnl was saved correctly.
  var totalPnl=filtered.reduce(function(s,r){return s+(parseFloat(r.pnl)||0);},0);
  var wins=allTrades.filter(function(t){return parseFloat(t.pnl)>0;});
  var losses=allTrades.filter(function(t){return parseFloat(t.pnl)<0;});
  var breakevens=allTrades.filter(function(t){return Math.abs(parseFloat(t.pnl)||0)<0.01;});
  // CHANGED: No-trade days are deliberate breakeven days (zero trades, net $0) — tracked alongside BE.
  var noTradeDays=filtered.filter(function(r){return r.noTradeDay&&(r.trades||[]).filter(function(t){return t.status!=="open";}).length===0;});
  var winRate=allTrades.length>0?Math.round((wins.length/allTrades.length)*100):0;
  // CHANGED: Snapshot-based trade count — falls back to wins+losses per row when r.trades is empty
  // (legacy corruption case). Prefers actual trades array length when present.
  var totalTradesCount=filtered.reduce(function(s,r){
    var n=(r.trades||[]).filter(function(t){return t&&t.status!=="open";}).length;
    if(n===0)n=(parseInt(r.wins)||0)+(parseInt(r.losses)||0);
    return s+n;
  },0);
  var breakevenRate=allTrades.length>0?Math.round((breakevens.length/allTrades.length)*100):0;
  var totalWins=wins.reduce(function(s,t){return s+parseFloat(t.pnl);},0);
  var totalLosses=Math.abs(losses.reduce(function(s,t){return s+parseFloat(t.pnl);},0));
  var avgWin=wins.length>0?totalWins/wins.length:0;
  var avgLoss=losses.length>0?totalLosses/losses.length:0;
  var pf=totalLosses>0?(totalWins/totalLosses).toFixed(2):totalWins>0?"∞":"0.00";
  var expValue=allTrades.length>0?totalPnl/allTrades.length:0;
  function pct(n){return (n>=0?"+":"")+n.toFixed(2)+"%";}
  function avgWinPct(){var arr=wins.map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});if(!arr.length)return "0%";return pct(arr.reduce(function(s,v){return s+v;},0)/arr.length);}
  function avgLossPct(){var arr=losses.map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});if(!arr.length)return "0%";return pct(arr.reduce(function(s,v){return s+v;},0)/arr.length);}
  function expPct(){var arr=allTrades.map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});if(!arr.length)return "0%";return pct(arr.reduce(function(s,v){return s+v;},0)/arr.length);}
  // Sec/Row defined at module scope below — they're collapsible.
  return (
    <div>
      {/* CHANGED: Sticky chip row — pinned just below the app header. The app shell already has a
          position:sticky title bar at top:0, so we offset below it (~64px) to stay visible. The
          parent has no top padding; the sticky element owns all spacing above/below "Performance"
          so the layout is symmetric in both rest and stuck states. */}
      <div style={{position:"sticky",top:70,zIndex:20,marginBottom:14,marginLeft:-12,marginRight:-12,paddingLeft:12,paddingRight:12,paddingTop:14,paddingBottom:10,background:"#0a0a0f",borderBottom:"1px solid #1e293b"}}>
        <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",marginBottom:8,lineHeight:1.2}}>Performance</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {/* CHANGED: Uses the shared Dropdown component (pill variant) for visual consistency app-wide. */}
          <Dropdown variant="pill" value={customMode?null:range} placeholder="Range" options={[
            {v:"thisweek",l:"This Week"},
            {v:"week",l:"Last Week"},
            {v:"month",l:"30 days"},
            {v:"mtd",l:"Month to Date"},
            {v:"3month",l:"3 Months"},
            {v:"year",l:"1 Year"},
            {v:"ytd",l:"Year to Date"},
            {v:"all",l:"All Time"}
          ]} onChange={function(v){var prevY=window.scrollY;setRange(v);setCustomMode(false);try{localStorage.setItem("tf-stats-range",v);}catch(e){}requestAnimationFrame(function(){window.scrollTo(0,prevY);});}}/>
          {/* CHANGED: Custom pill flips customMode on. The actual `range` stays at the prior preset
             until the user picks a date — so the page's data doesn't reset when the pill is tapped. */}
          <button onClick={function(){var prevY=window.scrollY;setCustomMode(true);requestAnimationFrame(function(){window.scrollTo(0,prevY);});}} style={{padding:props.mobile?"6px 14px":"7px 16px",background:customMode?"linear-gradient(135deg,#4338ca,#4f46e5)":"#0a0a0f",border:"1px solid "+(customMode?"#6366f1":"#334155"),borderRadius:999,color:customMode?"#fff":"#94a3b8",fontSize:props.mobile?12:13,fontWeight:customMode?700:500,cursor:"pointer",fontFamily:"inherit",boxShadow:customMode?"0 1px 4px #4f46e533":"none"}}>Custom</button>
        </div>
        {/* CHANGED: Date pickers reveal when Custom is selected. */}
        {customMode&&(
          <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center",flexWrap:"wrap"}}>
            <label style={{fontSize:11,color:"#94a3b8",letterSpacing:0.5}}>From</label>
            <input type="date" onMouseDown={function(e){var inp=e.currentTarget;setTimeout(function(){try{inp.focus();if(inp.showPicker)inp.showPicker();}catch(err){}},0);}} value={customStart} onChange={function(e){var v=e.target.value;setCustomStart(v);if(v||customEnd){setRange("custom");try{localStorage.setItem("tf-stats-range","custom");}catch(err){}}}} style={{padding:"5px 8px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,color:"#e2e8f0",fontSize:12,fontFamily:"inherit",colorScheme:"dark"}}/>
            <label style={{fontSize:11,color:"#94a3b8",letterSpacing:0.5}}>To</label>
            <input type="date" onMouseDown={function(e){var inp=e.currentTarget;setTimeout(function(){try{inp.focus();if(inp.showPicker)inp.showPicker();}catch(err){}},0);}} value={customEnd} onChange={function(e){var v=e.target.value;setCustomEnd(v);if(v||customStart){setRange("custom");try{localStorage.setItem("tf-stats-range","custom");}catch(err){}}}} style={{padding:"5px 8px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:6,color:"#e2e8f0",fontSize:12,fontFamily:"inherit",colorScheme:"dark"}}/>
            {(customStart||customEnd)&&<button onClick={function(){setCustomStart("");setCustomEnd("");setRange(range==="custom"?"all":range);try{localStorage.setItem("tf-stats-range",range==="custom"?"all":range);}catch(e){}}} style={{padding:"4px 9px",background:"transparent",border:"1px solid #334155",borderRadius:6,color:"#94a3b8",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>}
          </div>
        )}
      </div>
      {filtered.length>0&&(function(){
        // CHANGED: Gather summary stats for AI Coach.
        function bw(fieldKey,isArr){
          var g={};
          allTrades.forEach(function(t){var vals=isArr?(t[fieldKey]||[]):(t[fieldKey]?[t[fieldKey]]:[]);vals.forEach(function(v){if(!v)return;if(!g[v])g[v]={n:0,pcts:[]};g[v].n++;var pp=parseFloat(t.pctPnl);if(!isNaN(pp))g[v].pcts.push(pp);});});
          var q=Object.keys(g).filter(function(k){return g[k].n>=2;}).map(function(k){return {name:k,avg:g[k].pcts.length?g[k].pcts.reduce(function(s,v){return s+v;},0)/g[k].pcts.length:0};});
          if(!q.length)return {best:null,worst:null};
          q.sort(function(a,b){return b.avg-a.avg;});
          return {best:q[0].name,worst:q[q.length-1].name};
        }
        var setupBW=bw("setup",false);
        var sessBW=bw("sessionId",false);
        var emoBW=bw("emotions",true);
        var dirBW=bw("direction",false);
        var instBW=bw("instrument",false);
        var tfBW=bw("timeframe",false);
        // Map session ids -> names for readability.
        var sessNameMap={};getSessions(settings).forEach(function(s){sessNameMap[s.id]=s.name;});
        function sn(id){return id?(sessNameMap[id]||id):id;}
        var violCounts={};allTrades.forEach(function(t){(t.violations||[]).forEach(function(v){violCounts[v]=(violCounts[v]||0)+1;});});
        var topViol=Object.keys(violCounts).sort(function(a,b){return violCounts[b]-violCounts[a];})[0]||null;
        var tradesWithViol=allTrades.filter(function(t){return (t.violations||[]).length>0;}).length;
        var violRate=allTrades.length?Math.round(tradesWithViol/allTrades.length*100):0;
        var discScores=filtered.map(function(e){return parseFloat(e.disciplineScore);}).filter(function(v){return !isNaN(v);});
        var avgDisc=discScores.length?Math.round(discScores.reduce(function(s,v){return s+v;},0)/discScores.length):"n/a";
        // Expectancy in % and R.
        var pcts=allTrades.map(function(t){return parseFloat(t.pctPnl);}).filter(function(v){return !isNaN(v);});
        var expPct=pcts.length?(pcts.reduce(function(s,v){return s+v;},0)/pcts.length):0;
        var coachRisk=parseFloat(settings.riskMax)||0;
        var rVals=[];filtered.forEach(function(e){var rr=parseFloat(e.riskMax)||coachRisk;(e.trades||[]).forEach(function(t){if(t&&t.status!=="open"&&rr>0)rVals.push((parseFloat(t.pnl)||0)/rr);});});
        var expR=rVals.length?(rVals.reduce(function(s,v){return s+v;},0)/rVals.length):0;
        // Discipline → outcome link: avg trade % on high-discipline days vs low-discipline days.
        var discThr=loadDisciplineLockThreshold();
        var hiDayPct=[],loDayPct=[];
        filtered.forEach(function(e){
          var sc=parseFloat(e.disciplineScore);if(isNaN(sc))sc=calcDiscipline(e.trades||[],e.riskMax);
          (e.trades||[]).forEach(function(t){if(!t||t.status==="open")return;var pp=parseFloat(t.pctPnl);if(isNaN(pp))return;(sc>=discThr?hiDayPct:loDayPct).push(pp);});
        });
        function avg(a){return a.length?a.reduce(function(s,v){return s+v;},0)/a.length:null;}
        var hiAvg=avg(hiDayPct),loAvg=avg(loDayPct);
        // Overtrading: avg trades/day and busiest day.
        var perDay=filtered.map(function(e){return (e.trades||[]).filter(function(t){return t&&t.status!=="open";}).length;}).filter(function(n){return n>0;});
        var avgPerDay=perDay.length?(perDay.reduce(function(s,v){return s+v;},0)/perDay.length).toFixed(1):"n/a";
        var maxPerDay=perDay.length?Math.max.apply(null,perDay):0;
        // Revenge signal: avg % on the trade immediately after a loss vs baseline.
        var flat=[];filtered.forEach(function(e){(e.trades||[]).forEach(function(t){if(t&&t.status!=="open")flat.push(parseFloat(t.pctPnl));});});
        flat=flat.filter(function(v){return !isNaN(v);});
        var afterLoss=[];for(var fi=1;fi<flat.length;fi++){if(flat[fi-1]<0)afterLoss.push(flat[fi]);}
        var afterLossAvg=avg(afterLoss);
        // Recent trend: last 10 trades vs the rest.
        var last10=flat.slice(-10),prior=flat.slice(0,-10);
        var last10Avg=avg(last10),priorAvg=avg(prior);
        // Grade distribution.
        var gradeCounts={};allTrades.forEach(function(t){if(t.grade)gradeCounts[t.grade]=(gradeCounts[t.grade]||0)+1;});
        var gradeStr=Object.keys(gradeCounts).sort().map(function(g){return g+":"+gradeCounts[g];}).join(", ")||"ungraded";
        function pp(v){return v==null?"n/a":(v>=0?"+":"")+v.toFixed(2)+"%";}
        var stats={
          totalTrades:allTrades.length,winRate:winRate,breakevenRate:breakevenRate,pf:pf,
          avgWinPct:avgWinPct(),avgLossPct:avgLossPct(),
          expectancyPct:pp(expPct),expectancyR:(expR>=0?"+":"")+expR.toFixed(2)+"R",
          bestSetup:setupBW.best,worstSetup:setupBW.worst,
          bestSession:sn(sessBW.best),worstSession:sn(sessBW.worst),
          bestEmotion:emoBW.best,worstEmotion:emoBW.worst,
          bestDirection:dirBW.best,worstDirection:dirBW.worst,
          bestInstrument:instBW.best,worstInstrument:instBW.worst,
          bestTimeframe:tfBW.best,worstTimeframe:tfBW.worst,
          topViolation:topViol,violationRate:violRate+"%",
          avgDiscipline:avgDisc,disciplineThreshold:discThr,
          avgTradePctOnDisciplinedDays:pp(hiAvg),avgTradePctOnUndisciplinedDays:pp(loAvg),
          avgTradesPerDay:avgPerDay,maxTradesInADay:maxPerDay,
          avgPctAfterALoss:pp(afterLossAvg),overallAvgPct:pp(expPct),
          last10AvgPct:pp(last10Avg),priorAvgPct:pp(priorAvg),
          gradeDistribution:gradeStr,
          rangeLabel:({thisweek:"this week",week:"last week",month:"last 30 days","3month":"last 3 months",year:"last year",all:"all time"})[range]||range
        };
        return <AICoach stats={stats}/>;
      })()}
      {filtered.length>0&&<AchievementsPanel/>}
      {filtered.length===0&&<div style={{textAlign:"center",padding:"40px 20px",borderTop:"1px dashed #1e293b",marginTop:8}}><div style={{fontSize:14,color:"#475569"}}>No data for this range yet</div></div>}
      {filtered.length>0&&(
        <div>
          {/* CHANGED: CSS columns for true masonry packing — items flow vertically, balancing column heights. No empty gaps. */}
          <div style={{columnCount:props.mobile?1:3,columnGap:16}}>
          {(function(){
            // Equity sparkline: running cumulative P&L by day.
            var eq=[],c=0;filtered.forEach(function(r){c+=parseFloat(r.pnl)||0;eq.push(c);});
            var pfn=parseFloat(pf);
            var pfColor=pf==="∞"||pfn>1?"#22c55e":pfn<1?"#ef4444":"#94a3b8";
            // CHANGED: Helpers for running metrics — each compute(slice) returns a single value
            // representing the metric value as of the END of `slice`. Used by MetricChart.
            function computeWR(slice){var w=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){if(t.status==="open"||parseFloat(t.pnl)===0)return;n++;if(parseFloat(t.pnl)>0)w++;});});return n>0?(w/n*100):null;}
            function computeLR(slice){var l=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){if(t.status==="open"||parseFloat(t.pnl)===0)return;n++;if(parseFloat(t.pnl)<0)l++;});});return n>0?(l/n*100):null;}
            function computeBE(slice){var b=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){if(t.status==="open")return;n++;if(parseFloat(t.pnl)===0)b++;});});return n>0?(b/n*100):null;}
            function computePF(slice){var w=0,l=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){var p=parseFloat(t.pnl);if(isNaN(p)||t.status==="open")return;if(p>0)w+=p;else if(p<0)l+=Math.abs(p);});});if(l===0)return w>0?10:null;return w/l;}
            // CHANGED: Trades chart plots PER-DAY counts (last entry in slice), not cumulative.
            function computeTradeCount(slice){if(slice.length===0)return 0;var r=slice[slice.length-1];var n=0;(r.trades||[]).forEach(function(t){if(t.status!=="open")n++;});return n;}
            function computeAvgWin(slice){var w=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){var p=parseFloat(t.pnl);if(!isNaN(p)&&p>0&&t.status!=="open"){w+=p;n++;}});});return n>0?(w/n):null;}
            function computeAvgLoss(slice){var l=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){var p=parseFloat(t.pnl);if(!isNaN(p)&&p<0&&t.status!=="open"){l+=p;n++;}});});return n>0?(l/n):null;}
            function computeExp(slice){var sum=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){var p=parseFloat(t.pnl);if(!isNaN(p)&&t.status!=="open"){sum+=p;n++;}});});return n>0?(sum/n):null;}
            // CHANGED: % variants — used when HIDE_DOLLAR_PNL is on. Average the per-trade pctPnl
            // values, which already reflect each trade's % return — that's the meaningful "avg %".
            function computeAvgWinPct(slice){var w=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){var pp=parseFloat(t.pctPnl),pl=parseFloat(t.pnl);if(!isNaN(pp)&&!isNaN(pl)&&pl>0&&t.status!=="open"){w+=pp;n++;}});});return n>0?(w/n):null;}
            function computeAvgLossPct(slice){var l=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){var pp=parseFloat(t.pctPnl),pl=parseFloat(t.pnl);if(!isNaN(pp)&&!isNaN(pl)&&pl<0&&t.status!=="open"){l+=pp;n++;}});});return n>0?(l/n):null;}
            function computeExpPct(slice){var s=0,n=0;slice.forEach(function(r){(r.trades||[]).forEach(function(t){var pp=parseFloat(t.pctPnl);if(!isNaN(pp)&&t.status!=="open"){s+=pp;n++;}});});return n>0?(s/n):null;}
            var fmtPct=function(v){return v.toFixed(1)+"%";};
            var fmtNum=function(v){return v.toFixed(2);};
            var fmtCount=function(v){return Math.round(v).toString();};
            // CHANGED: fmtDollar now respects the global HIDE_DOLLAR_PNL toggle — returns % when on.
            var fmtDollar=function(v){if(HIDE_DOLLAR_PNL)return (v>=0?"+":"")+v.toFixed(2)+"%";return (v>=0?"+":"-")+"$"+Math.abs(v).toFixed(0);};
            // CHANGED: Chart shown based on selectedMetric. For Avg Win/Loss/Expectancy, swap to the
            // % compute when HIDE_DOLLAR_PNL is on so the line reflects what the format shows.
            function renderChart(){
              if(selectedMetric==="totalPnl")return <EquityCurve entries={filtered} range={range}/>;
              if(selectedMetric==="trades"){
                // CHANGED: Total trading time displayed to the right of the Trades value in the chart readout.
                var ttMs=0;filtered.forEach(function(r){(r.trades||[]).forEach(function(t){if(t&&t.status!=="open"){var d=tradeDurationMs(t);if(d>0)ttMs+=d;}});});
                var ttMeta=ttMs>0?(fmtDurationMs(ttMs)+" trading"):"";
                return <MetricChart entries={filtered} label="Trades per Day" color="#a5b4fc" compute={computeTradeCount} format={fmtCount} meta={ttMeta}/>;
              }
              if(selectedMetric==="profitFactor")return <MetricChart entries={filtered} minTrades={20} label="Profit Factor" color={pfColor} compute={computePF} format={fmtNum}/>;
              if(selectedMetric==="winRate")return <MetricChart entries={filtered} minTrades={20} label="Win Rate" color="#22c55e" compute={computeWR} format={fmtPct}/>;
              if(selectedMetric==="lossRate")return <MetricChart entries={filtered} minTrades={20} label="Loss Rate" color="#ef4444" compute={computeLR} format={fmtPct} invertChange/>;
              if(selectedMetric==="breakeven")return <MetricChart entries={filtered} minTrades={20} label="Breakeven Rate" color="#94a3b8" compute={computeBE} format={fmtPct}/>;
              if(selectedMetric==="avgWin")return <MetricChart entries={filtered} minTrades={20} label="Avg Win" color="#22c55e" compute={HIDE_DOLLAR_PNL?computeAvgWinPct:computeAvgWin} format={fmtDollar}/>;
              if(selectedMetric==="avgLoss")return <MetricChart entries={filtered} minTrades={20} label="Avg Loss" color="#ef4444" compute={HIDE_DOLLAR_PNL?computeAvgLossPct:computeAvgLoss} format={fmtDollar}/>;
              if(selectedMetric==="expectancy")return <MetricChart entries={filtered} minTrades={20} label="Expectancy / Trade" color={expValue>=0?"#22c55e":"#ef4444"} compute={HIDE_DOLLAR_PNL?computeExpPct:computeExp} format={fmtDollar}/>;
              return <EquityCurve entries={filtered} range={range}/>;
            }
            return <StatSec title="Overview" colSpan={props.mobile?1:6}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:6,padding:"4px 0"}}>
                <StatTile label="Total P&L" active={selectedMetric==="totalPnl"} onClick={function(){setSelectedMetric("totalPnl");}} value={HIDE_DOLLAR_PNL?(function(){
                  // CHANGED: For all-time / long ranges, % return is computed against total deposits
                  // (cumulative invested capital), not summed daily %s — much more meaningful.
                  if(range==="all"||range==="year"||range==="3month"){
                    var dep=0;try{(loadTransfers()||[]).forEach(function(tf){var a=parseFloat(tf.amount)||0;if(a>0)dep+=a;});}catch(e){}
                    if(dep>0)return (totalPnl>=0?"+":"")+(totalPnl/dep*100).toFixed(2)+"%";
                  }
                  // CHANGED: For shorter ranges, use the SAME formula as the equity curve:
                  // cumulative pnl / balance at start of range. The previous "sum of daily %s"
                  // disagreed with the curve readout because later days had larger denominators.
                  // Falls back to total-deposits if no start-of-range balance is available.
                  var startBal=0;
                  try{if(filtered.length>0){startBal=getAccountBalanceAtDate(filtered[0].date)-((parseFloat(filtered[0].pnl)||0));}}catch(x){}
                  if(!(startBal>0)){try{(loadTransfers()||[]).forEach(function(tf){var a=parseFloat(tf.amount)||0;if(a>0)startBal+=a;});}catch(x){}}
                  if(startBal>0)return (totalPnl>=0?"+":"")+(totalPnl/startBal*100).toFixed(2)+"%";
                  return "0.00%";
                })():((totalPnl>=0?"+":"-")+"$"+Math.abs(totalPnl).toFixed(2))} color={totalPnl>=0?"#22c55e":"#ef4444"}/>
                <StatTile label="Trades" active={selectedMetric==="trades"} onClick={function(){setSelectedMetric("trades");}} value={totalTradesCount} sub={tradingDays>0?(Math.ceil(totalTradesCount/tradingDays)+"/day · "+tradingDays+"d"):""}/>
                <StatTile label="Profit Factor" active={selectedMetric==="profitFactor"} onClick={function(){setSelectedMetric("profitFactor");}} value={pf} color={pfColor}/>
                <StatTile label="Win Rate" active={selectedMetric==="winRate"} onClick={function(){setSelectedMetric("winRate");}} value={winRate+"%"} color="#22c55e" sub={wins.length+" wins"}/>
                <StatTile label="Loss Rate" active={selectedMetric==="lossRate"} onClick={function(){setSelectedMetric("lossRate");}} value={(100-winRate-breakevenRate)+"%"} color="#ef4444" sub={losses.length+" losses"}/>
                <StatTile label="Breakeven" active={selectedMetric==="breakeven"} onClick={function(){setSelectedMetric("breakeven");}} value={breakevenRate+"%"} color="#94a3b8" sub={breakevens.length+" BE"}/>
                <StatTile label="Avg Win" active={selectedMetric==="avgWin"} onClick={function(){setSelectedMetric("avgWin");}} value={HIDE_DOLLAR_PNL?avgWinPct():("+$"+avgWin.toFixed(0))} color="#22c55e" sub={HIDE_DOLLAR_PNL?"":(avgWinPct())}/>
                <StatTile label="Avg Loss" active={selectedMetric==="avgLoss"} onClick={function(){setSelectedMetric("avgLoss");}} value={HIDE_DOLLAR_PNL?avgLossPct():("-$"+Math.abs(avgLoss).toFixed(0))} color="#ef4444" sub={HIDE_DOLLAR_PNL?"":(avgLossPct())}/>
                <StatTile label="Expectancy" active={selectedMetric==="expectancy"} onClick={function(){setSelectedMetric("expectancy");}} value={HIDE_DOLLAR_PNL?expPct():((expValue>=0?"+":"-")+"$"+Math.abs(expValue).toFixed(2))} color={expValue>=0?"#22c55e":"#ef4444"} sub={HIDE_DOLLAR_PNL?"":expPct()}/>
              </div>
              {/* CHANGED: Chart embedded directly under Overview tiles — clicking a tile swaps the chart. */}
              <div style={{marginTop:14,paddingTop:12,borderTop:"1px solid #1e293b"}}>{renderChart()}</div>
            </StatSec>;
          })()}
          {/* CHANGED: Order per user spec — EquityCurve, then Daily P&L (under it), then Heatmap. */}
          <StatSec title="Daily P&L">
            <DailyPnLBar entries={filtered}/>
          </StatSec>
          <div style={{breakInside:"avoid",WebkitColumnBreakInside:"avoid",marginBottom:16}}><StreakTracker rows={filtered} settings={settings}/></div>
          {/* CHANGED: R-Multiple + Discipline Scatter rendered consecutively so they group in the masonry. */}
          <div style={{breakInside:"avoid",WebkitColumnBreakInside:"avoid",marginBottom:16}}><RMultipleHistogram rows={filtered} fallbackRiskMax={parseFloat(settings.riskMax)||0}/></div>
          <div style={{breakInside:"avoid",WebkitColumnBreakInside:"avoid",marginBottom:16}}><DisciplineScatter rows={filtered} settings={settings} range={range} onNavigateToTrade={props.onNavigateToTrade}/></div>
          <div style={{breakInside:"avoid",WebkitColumnBreakInside:"avoid",marginBottom:16}}><SessionDayHeatmap rows={filtered} settings={settings}/></div>
          {(function(){
            function renderBreakdown(title,groups,sparkBase){
              var rows=Object.keys(groups).map(function(k){
                var g=groups[k];
                var wr=g.n>0?Math.round((g.w/g.n)*100):0;
                var avgPct=g.pcts.length>0?(g.pcts.reduce(function(s,v){return s+v;},0)/g.pcts.length):0;
                var exp=g.n>0?g.pnl/g.n:0;
                // CHANGED: Carry raw pnl + pcts forward — totalContrib computation downstream needs them.
                return {k:k,n:g.n,wr:wr,avgPct:avgPct,exp:exp,pnl:g.pnl,pcts:g.pcts};
              });
              // CHANGED: Sort by trade count desc — most-traded patterns surface first, since
              // they carry the most signal. Expectancy is shown on each row for context.
              rows.sort(function(a,b){return b.n-a.n;});
              var max=Math.max.apply(null,rows.map(function(r){return Math.abs(HIDE_DOLLAR_PNL?r.avgPct:r.exp);}).concat([0.0001]));
              // CHANGED: Bar length now represents TOTAL contribution (sum across trades) instead
               // of per-trade expectancy, so frequently-traded patterns get more visual weight
               // than 1-trade outliers. The right-side number remains the per-trade expectancy.
              var rowsTotal=rows.map(function(r){return Object.assign({},r,{totalContrib:HIDE_DOLLAR_PNL?(r.pcts||[]).reduce(function(s,x){return s+x;},0):r.pnl});});
              var maxTotal=Math.max.apply(null,rowsTotal.map(function(r){return Math.abs(r.totalContrib);}).concat([0]));
              var totalN=rowsTotal.reduce(function(s,r){return s+r.n;},0);
              var positive=rowsTotal.filter(function(r){return r.exp>0;}).length;
              var preview=totalN>0?(rowsTotal.length+" tags · "+positive+" green"):"";
              return (
                <StatSec key={title} title={title} colSpan={props.mobile?1:6}>
                  {rowsTotal.length===0&&<div style={{fontSize:13,color:"#64748b",fontStyle:"italic",padding:"4px 0"}}>No data yet.</div>}
                  {rowsTotal.map(function(r,i){
                    // CHANGED: Bars removed — they were noisy and not informative once WR + count + dollar value are shown. Plain rows now.
                    var wrColor=r.wr>=50?"#22c55e":r.wr>=33?"#fbbf24":"#ef4444";
                    var pnlText=HIDE_DOLLAR_PNL?((r.avgPct>=0?"+":"")+r.avgPct.toFixed(1)+"%"):((r.exp>=0?"+":"-")+"$"+Math.abs(r.exp).toFixed(0));
                    return (
                      <div key={r.k} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"7px 0",borderBottom:i===rowsTotal.length-1?"none":"1px solid #1e293b",gap:8}}>
                        <span style={{fontSize:13,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0}}>{r.k}</span>
                        <span style={{fontSize:12,fontWeight:700,color:wrColor,fontVariantNumeric:"tabular-nums",flexShrink:0}}>{r.wr}% wr<span style={{fontSize:10,color:"#94a3b8",fontWeight:500,marginLeft:6}}>· {r.n}t · {pnlText}</span></span>
                      </div>
                    );
                  })}
                </StatSec>
              );
            }
            var setupG={},cpG={},indG={};
            allTrades.forEach(function(t){
              var p=parseFloat(t.pnl)||0,pp=parseFloat(t.pctPnl);
              function bump(g,k){if(!g[k])g[k]={n:0,w:0,pnl:0,pcts:[]};g[k].n++;g[k].pnl+=p;if(p>0)g[k].w++;if(!isNaN(pp))g[k].pcts.push(pp);}
              if(t.setup)bump(setupG,t.setup);
              if(t.candlePattern)bump(cpG,t.candlePattern);
              (t.indicators||[]).forEach(function(ind){bump(indG,ind);});
            });
            return <>{renderBreakdown("Setups",setupG)}{renderBreakdown("Candle Patterns",cpG)}{renderBreakdown("Indicators",indG)}</>;
          })()}
          {(function(){
            if(allTrades.length===0)return null;
            function bestWorst(fieldKey,isArr){
              var groups={};
              allTrades.forEach(function(t){
                var vals=isArr?(t[fieldKey]||[]):(t[fieldKey]?[t[fieldKey]]:[]);
                vals.forEach(function(v){
                  if(!v)return;
                  if(!groups[v])groups[v]={n:0,w:0,pcts:[]};
                  groups[v].n++;
                  if((parseFloat(t.pnl)||0)>0)groups[v].w++;
                  var pp=parseFloat(t.pctPnl);if(!isNaN(pp))groups[v].pcts.push(pp);
                });
              });
              // Require >=2 trades to qualify (avoid one-trade flukes).
              var qualified=Object.keys(groups).filter(function(k){return groups[k].n>=2;}).map(function(k){
                var g=groups[k];
                return {name:k,n:g.n,wr:Math.round((g.w/g.n)*100),avgPct:g.pcts.length>0?g.pcts.reduce(function(s,v){return s+v;},0)/g.pcts.length:0};
              });
              if(qualified.length===0)return null;
              // CHANGED: Sort by win rate (descending). Best = highest wr, Worst = lowest wr.
              // Tiebreak by avg % so two equal-wr buckets don't flip order randomly.
              qualified.sort(function(a,b){return (b.wr-a.wr)||(b.avgPct-a.avgPct);});
              return {best:qualified[0],worst:qualified[qualified.length-1]};
            }
            var setupBW=bestWorst("setup",false);
            var cpBW=bestWorst("candlePattern",false);
            var indBW=bestWorst("indicators",true);
            if(!setupBW&&!cpBW&&!indBW)return null;
            function row(label,bw,isLast){
              if(!bw)return null;
              var same=bw.best.name===bw.worst.name;
              var Card=function(item,kind){
                var bd=kind==="best"?"#16653466":"#7f1d1d66";
                var bg=kind==="best"?"#0a1f1022":"#1c0a0a22";
                var col=kind==="best"?"#22c55e":"#ef4444";
                return (
                  <div style={{minWidth:0,padding:"8px 10px",background:bg,border:"1px solid "+bd,borderRadius:6}}>
                    <div style={{fontSize:9,color:"#e2e8f0",fontWeight:700,letterSpacing:1,textTransform:"uppercase",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                    <div style={{fontSize:9,fontWeight:700,color:col,marginTop:3,fontVariantNumeric:"tabular-nums",letterSpacing:1}}>{item.wr}<span style={{marginLeft:2}}>% WR</span></div>
                    <div style={{fontSize:10,color:"#94a3b8",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{item.n}t · {(item.avgPct>=0?"+":"")+item.avgPct.toFixed(2)}%</div>
                  </div>
                );
              };
              return (
                <div style={{padding:"8px 0",borderBottom:isLast?"none":"1px solid #1e293b",display:"grid",gridTemplateColumns:"90px 1fr",gap:8,alignItems:"center"}}>
                  <div style={{fontSize:10,color:"#cbd5e1",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>{label}</div>
                  {/* CHANGED: Always render two columns; if only one item qualifies, the other side
                     gets a dimmed placeholder so the card width stays consistent across rows. */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                    {Card(bw.best,"best")}
                    {same?<div style={{minWidth:0,padding:"8px 10px",background:"#0a0a0f",border:"1px dashed #1e293b",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:10,color:"#475569",fontStyle:"italic"}}>same as best</span></div>:Card(bw.worst,"worst")}
                  </div>
                </div>
              );
            }
            // Determine which row is last (for proper border handling).
            var rows=[];
            if(setupBW)rows.push(["Setup",setupBW]);
            if(cpBW)rows.push(["Candle Pattern",cpBW]);
            if(indBW)rows.push(["Indicator",indBW]);
            return (
              <StatSec title="Best / Worst" colSpan={props.mobile?1:6}>
                {/* CHANGED: Single BEST / WORST column header at the top of the section, aligned with the card columns below. */}
                <div style={{display:"grid",gridTemplateColumns:"90px 1fr",gap:8,alignItems:"center",paddingBottom:6,borderBottom:"1px solid #1e293b",marginBottom:2}}>
                  <div/>
                  <div style={{display:"flex",gap:6}}>
                    <div style={{flex:1,fontSize:9,color:"#86efac",letterSpacing:1,fontWeight:700,textAlign:"center"}}>▲ BEST</div>
                    <div style={{flex:1,fontSize:9,color:"#fca5a5",letterSpacing:1,fontWeight:700,textAlign:"center"}}>▼ WORST</div>
                  </div>
                </div>
                {rows.map(function(r,i){return <div key={r[0]}>{row(r[0],r[1],i===rows.length-1)}</div>;})}
                <div style={{fontSize:10,color:"#64748b",fontStyle:"italic",marginTop:6,paddingTop:6,borderTop:"1px solid #1e293b"}}>Ranked by win rate. Minimum 2 trades to qualify.</div>
              </StatSec>
            );
          })()}
          {(function(){
            var groups={};
            var cleanN=0,violN=0;
            allTrades.forEach(function(t){
              var vs=(t.violations||[]);
              if(vs.length===0){cleanN++;return;}
              violN++;
              vs.forEach(function(v){
                if(!groups[v])groups[v]={n:0,lossN:0,lossPnl:0,lossPcts:[]};
                groups[v].n++;
                var p=parseFloat(t.pnl)||0;
                var pp=parseFloat(t.pctPnl);
                // CHANGED: Track only the LOSING trades for this violation. We surface average loss —
                // not win rate or expectancy — so the breakdown highlights the cost of rule-breaking
                // rather than implying it can pay off.
                if(p<0){groups[v].lossN++;groups[v].lossPnl+=p;if(!isNaN(pp))groups[v].lossPcts.push(pp);}
              });
            });
            // CHANGED: Add synthetic "Discipline threshold broken" entry counting days the lock triggered.
            // The metric is day-level (not trade-level), so we count locked days and aggregate that day's
            // losing P&L into the "avg loss" column for consistency with the other rows.
            var lockedDays=filtered.filter(function(r){return !!r.wasLocked;});
            if(lockedDays.length>0){
              var grp={n:lockedDays.length,lossN:0,lossPnl:0,lossPcts:[]};
              lockedDays.forEach(function(r){
                var dayPnl=(r.trades||[]).reduce(function(s,t){return s+(t&&t.status!=="open"?(parseFloat(t.pnl)||0):0);},0);
                if(dayPnl<0){grp.lossN++;grp.lossPnl+=dayPnl;}
              });
              groups["Discipline threshold broken"]=grp;
            }
            var keys=Object.keys(groups).sort(function(a,b){return groups[b].n-groups[a].n;});
            var total=allTrades.length;
            var cleanRate=total>0?Math.round((cleanN/total)*100):0;
            // CHANGED: Sparkline = per-day violation count across the filtered range (so user sees the trend at a glance).
            var violSpark=filtered.map(function(r){return (r.trades||[]).reduce(function(s,t){return s+((t&&t.status!=="open"&&t.violations)?t.violations.length:0);},0);});
            return (
              <StatSec title="Rule Violations" colSpan={props.mobile?1:6}>
                {keys.length===0&&<div style={{fontSize:13,color:"#64748b",fontStyle:"italic",padding:"4px 0"}}>No rule violations in this range. Clean record!</div>}
                {keys.length>0&&(
                  <div style={{fontSize:11,color:"#64748b",padding:"2px 0 8px",borderBottom:"1px solid #1e293b",marginBottom:6}}>{violN} of {total} trade{total===1?"":"s"} flagged · <span style={{color:wrColor(cleanRate)}}>{cleanRate}% clean</span>{lockedDays.length>0?" · "+lockedDays.length+" discipline lock"+(lockedDays.length===1?"":"s"):""}</div>
                )}
                {keys.map(function(k,i){
                  var g=groups[k];
                  var isLock=k==="Discipline threshold broken";
                  var lossRate=g.n>0?Math.round((g.lossN/g.n)*100):0;
                  var avgLoss=g.lossN>0?g.lossPnl/g.lossN:0;
                  var avgLossPct=g.lossPcts.length>0?(g.lossPcts.reduce(function(s,v){return s+v;},0)/g.lossPcts.length):0;
                  var lossStr=g.lossN>0?(HIDE_DOLLAR_PNL?(avgLossPct.toFixed(2)+"%"):("-$"+Math.abs(avgLoss).toFixed(2))):"—";
                  var unit=isLock?"day":"trade";
                  return (
                    <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:i<keys.length-1?"1px solid #1e293b":"none",gap:8}}>
                      <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",gap:7}}>
                        {isLock?(
                          <span style={{fontSize:9,fontWeight:800,color:"#fff",background:"#ef4444",borderRadius:3,padding:"1px 4px",lineHeight:1,letterSpacing:0.3,flexShrink:0}}>D</span>
                        ):(
                          <span style={{width:6,height:6,borderRadius:"50%",background:"#ef4444",flexShrink:0}}/>
                        )}
                        <div style={{minWidth:0}}>
                          <div style={{fontSize:13,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{k}</div>
                          {/* CHANGED: For the lock row, show N / total trading days in the journal range. */}
                          <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{isLock?(g.n+" / "+filtered.length+" trading day"+(filtered.length===1?"":"s")):(g.n+" "+unit+(g.n===1?"":"s"))} · <span style={{color:"#fca5a5"}}>{g.lossN} {isLock?("red day"+(g.lossN===1?"":"s")):("loss"+(g.lossN===1?"":"es"))} ({lossRate}%)</span></div>
                        </div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}><div style={{fontSize:13,fontWeight:700,color:g.lossN>0?"#ef4444":"#64748b",fontVariantNumeric:"tabular-nums"}}>{lossStr}</div><div style={{fontSize:10,color:"#94a3b8",fontWeight:600,marginTop:1}}>{g.lossN>0?(isLock?"avg red day":"avg loss"):"no losses"}</div></div>
                    </div>
                  );
                })}
              </StatSec>
            );
          })()}
          {/* CHANGED: "What's Working / What's Hurting" panel removed — the Best/Worst section
             above shows the same setup/pattern/indicator-level read with WR + count + return,
             so the duplicate panel just took space without adding info. */}
          {(function(){
            function summarize(filterFn){
              var n=0,w=0,l=0,pnl=0,pcts=[];
              allTrades.forEach(function(t){
                if(!filterFn(t))return;
                n++;var p=parseFloat(t.pnl)||0;pnl+=p;
                if(p>0)w++;else if(p<0)l++;
                var pp=parseFloat(t.pctPnl);if(!isNaN(pp))pcts.push(pp);
              });
              var wr=n>0?Math.round((w/n)*100):0;
              var lr=n>0?Math.round((l/n)*100):0;
              var avgPct=pcts.length>0?(pcts.reduce(function(s,v){return s+v;},0)/pcts.length):0;
              var expectancy=n>0?pnl/n:0;
              return {n:n,wr:wr,lr:lr,avgPct:avgPct,expectancy:expectancy};
            }
            var cats=[
              {label:"No setup tagged",stat:summarize(function(t){return !t.setup;})},
              {label:"No candle pattern",stat:summarize(function(t){return !t.candlePattern;})},
              {label:"No indicators",stat:summarize(function(t){return !(t.indicators&&t.indicators.length>0);})},
            ].filter(function(c){return c.stat.n>0;});
            // CHANGED: Sort by loss rate descending — the worst-hit untagged category gets called out first.
            cats.sort(function(a,b){return b.stat.lr-a.stat.lr;});
            if(cats.length===0)return null;
            return (
              <StatSec title="Untagged Trades" colSpan={props.mobile?1:6}>
                {cats.map(function(c,i){
                  var g=c.stat;
                  var pnlStr=HIDE_DOLLAR_PNL?((g.avgPct>=0?"+":"")+g.avgPct.toFixed(2)+"%"):((g.expectancy>=0?"+":"-")+"$"+Math.abs(g.expectancy).toFixed(2)+" exp");
                  var avgPctStr=(g.avgPct>=0?"+":"")+g.avgPct.toFixed(2)+"% avg";
                  return (
                    <div key={c.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:i<cats.length-1?"1px solid #1e293b":"none",gap:8}}>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.label}</div>
                        <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{g.n} trade{g.n===1?"":"s"} · {g.wr}% WR</div>
                      </div>
                      {/* CHANGED: LR is the primary big number; expectancy + avg drop to small secondary text. */}
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div style={{fontSize:18,fontWeight:800,color:g.lr>=50?"#ef4444":g.lr>=33?"#fbbf24":"#94a3b8",fontVariantNumeric:"tabular-nums",letterSpacing:-0.3,lineHeight:1}}>{g.lr}<span style={{marginLeft:2}}>% LR</span></div>
                        <div style={{fontSize:10,color:"#94a3b8",fontVariantNumeric:"tabular-nums",marginTop:3}}>{pnlStr}</div>
                      </div>
                    </div>
                  );
                })}
                <div style={{fontSize:10,color:"#64748b",fontStyle:"italic",marginTop:6,paddingTop:6,borderTop:"1px solid #1e293b"}}>Sorted by loss rate. Tag these trades in the journal for cleaner breakdowns.</div>
              </StatSec>
            );
          })()}
          {(function(){
            var beSpark=filtered.map(function(r){
              var ct=(r.trades||[]).filter(function(t){return t&&t.status!=="open";});
              if(ct.length===0)return 0;
              var be=ct.filter(function(t){return Math.abs(parseFloat(t.pnl)||0)<0.01;}).length;
              return Math.round((be/ct.length)*100);
            });
            return <StatSec title="Breakeven Analysis">
            <StatRow label="Total Breakevens" value={breakevens.length+" ("+breakevenRate+"%)"} color="#94a3b8"/>
            <StatRow label="Win/Loss/BE Split" value={wins.length+"/"+(losses.length)+"/"+breakevens.length} color="#64748b"/>
            {breakevens.length>0&&(
              <>
                <StatRow label="Avg Breakeven Cost" value={HIDE_DOLLAR_PNL?"$•••":"$"+(breakevens.reduce(function(s,t){return s+(Math.abs(parseFloat(t.pnl)||0));},0)/breakevens.length).toFixed(2)}/>
                <StatRow label="Breakeven Frequency" value={(breakevenRate>0?breakevenRate:"0")+"%"} color={breakevenRate>10?"#fbbf24":"#94a3b8"}/>
              </>
            )}
            {breakevens.length===0&&<StatRow label="Status" value="No breakevens yet" color="#86efac"/>}
            {/* CHANGED: No-trade days — deliberate sit-outs that net breakeven for the day. */}
            <StatRow label="No-Trade Days" value={noTradeDays.length+" day"+(noTradeDays.length===1?"":"s")} last={noTradeDays.length===0} color={noTradeDays.length>0?"#fcd34d":"#64748b"}/>
            {noTradeDays.length>0&&(function(){
              // Tally reason tags across no-trade days in range.
              var counts={};
              noTradeDays.forEach(function(d){
                var reasons=(d.noTradeReasons&&d.noTradeReasons.length)?d.noTradeReasons:(d.noTradeReason?["(custom)"]:[]);
                reasons.forEach(function(r){counts[r]=(counts[r]||0)+1;});
              });
              var keys=Object.keys(counts).sort(function(a,b){return counts[b]-counts[a];});
              if(keys.length===0)return <StatRow label="Reasons" value="(none tagged)" last color="#64748b"/>;
              return (
                <div style={{padding:"8px 0 4px",borderBottom:"none"}}>
                  <div style={{fontSize:11,color:"#94a3b8",marginBottom:6,fontWeight:600}}>Reasons</div>
                  {keys.map(function(k,i){
                    var n=counts[k];
                    var pct=Math.round((n/noTradeDays.length)*100);
                    return (
                      <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",borderBottom:i<keys.length-1?"1px solid #1e293b":"none"}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,minWidth:0,flex:1}}>
                          <span style={{width:5,height:5,borderRadius:"50%",background:"#fbbf24",flexShrink:0}}/>
                          <span style={{fontSize:12,color:"#cbd5e1",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{k}</span>
                        </div>
                        <span style={{fontSize:12,color:"#fcd34d",fontWeight:700,flexShrink:0,marginLeft:8}}>{n} <span style={{fontSize:10,color:"#64748b",fontWeight:500}}>({pct}%)</span></span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            </StatSec>;
          })()}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionsEditor(props){
  var label=props.label,values=props.values,onChange=props.onChange,sentiments=props.sentiments,onSentimentChange=props.onSentimentChange;
  var [adding,setAdding]=useState(false);
  var [newVal,setNewVal]=useState("");
  // CHANGED: Drag-to-reorder state.
  var [dragIdx,setDragIdx]=useState(null);
  var [dragOverIdx,setDragOverIdx]=useState(null);
  function add(){var v=(newVal||"").trim();if(!v||values.indexOf(v)>=0)return;onChange(values.concat([v]));setNewVal("");setAdding(false);}
  function onDragStart(i){setDragIdx(i);}
  function onDragOver(e,i){e.preventDefault();setDragOverIdx(i);}
  function onDrop(i){
    if(dragIdx===null||dragIdx===i)return;
    var arr=values.slice();
    var moved=arr.splice(dragIdx,1)[0];
    arr.splice(i,0,moved);
    onChange(arr);
    if(sentiments&&onSentimentChange){/* sentiments keyed by value, no reorder needed */}
    setDragIdx(null);setDragOverIdx(null);
  }
  function onDragEnd(){setDragIdx(null);setDragOverIdx(null);}
  return (
    <div style={{marginBottom:12}}>
      <div style={{fontSize:12,color:"#64748b",letterSpacing:1,textTransform:"uppercase",marginBottom:6,fontWeight:600}}>{label}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
        {values.map(function(v,i){
          var sent=sentiments?getEmotionSentiment(v,sentiments):null;
          var sc=sent==="positive"?"#22c55e":sent==="negative"?"#ef4444":"#94a3b8";
          var isDragging=dragIdx===i;
          var isDragOver=dragOverIdx===i&&dragIdx!==i;
          return (
            <div key={v}
              draggable
              onDragStart={function(){onDragStart(i);}}
              onDragOver={function(e){onDragOver(e,i);}}
              onDrop={function(){onDrop(i);}}
              onDragEnd={onDragEnd}
              style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",background:isDragOver?"#1e1b4b":"#1e293b",border:"1px solid "+(isDragOver?"#4338ca":"#334155"),borderRadius:4,opacity:isDragging?0.4:1,cursor:"grab",transition:"background 0.1s,border-color 0.1s"}}>
              <span style={{fontSize:10,color:"#64748b",cursor:"grab",marginRight:1}}>⠿</span>
              {sentiments&&onSentimentChange&&<select value={sent||"neutral"} onChange={function(e){var ns=Object.assign({},sentiments);ns[v]=e.target.value;onSentimentChange(ns);}} style={{background:"transparent",border:"none",color:sc,fontSize:11,cursor:"pointer",fontFamily:"inherit",fontWeight:600,padding:0}}><option value="positive" style={{background:"#1e293b"}}>+</option><option value="neutral" style={{background:"#1e293b"}}>=</option><option value="negative" style={{background:"#1e293b"}}>-</option></select>}
              <span style={{fontSize:13,color:"#e2e8f0"}}>{v}</span>
              <button onClick={function(){onChange(values.filter(function(x){return x!==v;}));if(sentiments&&onSentimentChange){var ns=Object.assign({},sentiments);delete ns[v];onSentimentChange(ns);}}} style={{background:"none",border:"none",color:"#64748b",fontSize:13,cursor:"pointer",padding:"0 0 0 2px",lineHeight:1,fontFamily:"inherit"}}>×</button>
            </div>
          );
        })}
        {adding?(
          <div style={{display:"flex",gap:4,alignItems:"center"}}>
            <input autoFocus value={newVal} onChange={function(e){setNewVal(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")add();if(e.key==="Escape"){setAdding(false);setNewVal("");}}} placeholder="New..." style={Object.assign({},fld,{padding:"4px 8px",fontSize:13,width:120})}/>
            <button onClick={add} style={{padding:"4px 9px",background:"#4f46e5",border:"none",borderRadius:4,color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Add</button>
            <button onClick={function(){setAdding(false);setNewVal("");}} style={{padding:"4px 9px",background:"none",border:"1px solid #334155",borderRadius:4,color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          </div>
        ):<button onClick={function(){setAdding(true);}} style={{padding:"3px 9px",background:"transparent",border:"1px dashed #475569",borderRadius:4,color:"#64748b",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>+ Add</button>}
      </div>
    </div>
  );
}

// CHANGED: In-app help guide — a plain-language walkthrough of how the app works, grouped by tab
// plus the core discipline mechanics. Rendered as the first (collapsible) section of Settings.
function HelpGuide(){
  var h={fontSize:13,fontWeight:700,color:"#e2e8f0",margin:"14px 0 6px"};
  var p={fontSize:13,color:"#94a3b8",lineHeight:1.6,margin:"0 0 8px"};
  var em={color:"#cbd5e1",fontWeight:600};
  var li={fontSize:13,color:"#94a3b8",lineHeight:1.6,margin:"0 0 6px",paddingLeft:14,position:"relative"};
  var dot={position:"absolute",left:0,top:0,color:"#6366f1"};
  function L(props){return <div style={li}><span style={dot}>•</span>{props.children}</div>;}
  return (
    <div>
      <p style={Object.assign({},p,{color:"#cbd5e1"})}>Psycho-Trader is a trading journal built to enforce discipline, not just record trades. The core idea: it actively pushes back on the behaviors that blow up accounts — overtrading, revenge trading, sizing up too fast, and trading on tilt. Here's how each part works.</p>

      <div style={h}>The five tabs</div>
      <L><span style={em}>Dashboard</span> — your daily home base. Account balance, today's focus, calendar of past days, and your clean-day streak.</L>
      <L><span style={em}>Trades</span> — log trades for the day. Start here each morning: complete the pre-market checklist, commit to a plan, then log entries as you take them. Editable trade cards with screenshots, indicators, candle patterns, emotional state, and grade.</L>
      <L><span style={em}>Goals</span> — your targets for P&L, win rate, account milestones, and discipline. Custom goals can be filed under default sections (Performance / P&L / Account) or your own named sections.</L>
      <L><span style={em}>Performance</span> — your stats and patterns: win rate, profit factor, expectancy, Session×Day heatmap, R-multiple distribution, discipline-vs-R scatter, and per-tag breakdowns for Setups / Candle Patterns / Indicators. Use the dropdown to scope by this week (Sun–today), last week (Sun–Sat), month, 3-month, year, or all time.</L>
      <L><span style={em}>Settings</span> — balance, sizing parameters, sessions, checklists, discipline scoring, backup/restore, and sign-out.</L>

      <div style={h}>Starting your trading day</div>
      <p style={p}>On the Trades tab, first work through the <span style={em}>Pre-Market Checklist</span>. Until it's complete, position and risk sizing stay hidden so you can't jump in unprepared. Then set your <span style={em}>commitment</span>: max trades for the day (derived automatically from your Session Strategy) and which setups you'll take. Once committed, it locks — you can't quietly rewrite the plan mid-day when you're tempted.</p>

      <div style={h}>The half-size lock (the heart of the app)</div>
      <p style={p}>Every day gets a <span style={em}>discipline score</span> out of 100. You start at 100 and lose points for rule violations, negative emotions, exceeding your commitment, and ignoring the setup review; you gain a little for A-grades and positive emotional state. If your score drops below your <span style={em}>lock threshold</span> (default 85), the app <span style={em}>auto-halves your position and risk caps</span> rather than blocking trades outright — half-size trading stays active for one full trading day (a weekend serves as cooldown, so a Friday lock clears Monday). The lock is immutable once triggered — later score recomputes can't make it disappear.</p>
      <p style={p}>Hard stops (session daily-loss / daily-gain limits) and the "Oversized entry" violation also scale to the half-size cap, so the entire risk profile shrinks together. The banner shows when the lock was triggered (today, yesterday, or N days ago).</p>

      <div style={h}>How the discipline score works</div>
      <p style={p}>The score is mostly about <span style={em}>process</span>, not profit — deliberately. A disciplined losing day can still score well; a reckless winning day won't. There's a small outcome term based on your R-multiple (day P&L ÷ your max risk), but it's capped and can't rescue a day that broke the rules: a profitable day with violations gets no outcome bonus, and the lock decision uses the process-only score. Tune penalties and the R-term in the Discipline Scoring section.</p>

      <div style={h}>Position sizing &amp; scaling</div>
      <p style={p}>Position and risk caps are read from <span style={em}>Auto-Sizing Parameters</span> in Settings. They're then scaled by the active session's <span style={em}>sizeFraction</span> (e.g., a 0.7 size fraction for an aggressive session yields 70% of base), and halved again if you're in a half-size lock.</p>

      <div style={h}>Session Strategy</div>
      <p style={p}>Define your trading sessions in Settings (pre-market, opening, midday, closing, etc.) with start/end times, size fractions, max trades, daily R loss/gain stops, and days-of-week. Each trade is automatically attributed to its session based on when you entered. Off-hours trades get attributed to the nearest enabled session so they still show in the heatmap and breakdowns.</p>

      <div style={h}>Streaks &amp; commitment review</div>
      <L><span style={em}>Clean-day streak</span> — consecutive trading days where your discipline stayed above the lock threshold, win or lose. Only trading days count; weekends and days off don't break it. Your personal best is saved.</L>
      <L><span style={em}>Commitment review</span> — at day's end, the app checks your stated plan against what actually happened: did you stay within your trade cap, did you stick to your committed setups. Following your own plan is the win, regardless of P&L.</L>

      <div style={h}>Withdrawals</div>
      <p style={p}>Your withdrawal allowance is <span style={em}>30% of the profit you've earned since your last withdrawal</span> — so cashing out is tied directly to growth. Deposits and withdrawals (with running totals) live in Settings → Balance.</p>

      <div style={h}>Your data &amp; sync</div>
      <p style={p}>Data syncs to Supabase under your account so it follows you across devices. On sign-in to a new device, the app pulls your cloud history. Use <span style={em}>Import / Export</span> in Settings to export a JSON snapshot you can keep offline or migrate. Sign out from the bottom of Settings.</p>

      <p style={Object.assign({},p,{marginTop:14,color:"#64748b",fontSize:12})}>The philosophy: make the disciplined choice the easy one and the reckless choice harder. The friction is the feature.</p>
    </div>
  );
}

function SettingsSection(props){
  var [open,setOpen]=useState(props.defaultOpen||false);
  // CHANGED: forceOpen lets a parent expand this section on demand (e.g. dashboard Withdraw button).
  // CHANGED: forceOpen lets a parent expand this section on demand (e.g. dashboard Withdraw button).
  useEffect(function(){if(props.forceOpen)setOpen(true);},[props.forceOpen]);
  return (
    <div style={CS({marginBottom:10,padding:0})}>
      <button onClick={function(){setOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
        <span style={{fontSize:13,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>{props.title}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{display:"inline-block",verticalAlign:"middle",transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open&&<div style={{padding:"4px 16px 14px",borderTop:"1px solid #1e293b"}}>{props.children}</div>}
    </div>
  );
}

function SettingsTab(props){
  var settings=props.settings,setSettings=props.setSettings,tradeOptions=props.tradeOptions,setTradeOptions=props.setTradeOptions;
  var [transfers,setTransfers]=useState(loadTransfers());
  var [transferDraft,setTransferDraft]=useState({type:"withdrawal",date:(function(){var n=getNow();return n.getFullYear()+"-"+(n.getMonth()+1).toString().padStart(2,"0")+"-"+n.getDate().toString().padStart(2,"0");})(),amount:props.initialTransferAmount?String(props.initialTransferAmount):"",note:""});
  // CHANGED: When navigated here via the dashboard Withdraw button, pre-fill the withdrawal amount.
  useEffect(function(){if(props.initialTransferAmount){setTransferDraft(function(d){return Object.assign({},d,{type:"withdrawal",amount:String(props.initialTransferAmount)});});}},[props.initialTransferAmount]);
  // CHANGED: Allowance-target notification input.
  var [allowanceTargetInput,setAllowanceTargetInput]=useState(function(){var v=getAllowanceTarget();return v>0?String(v):"";});
  var [instruments,setInstruments]=useState(loadInstruments());
  var [newInst,setNewInst]=useState({symbol:"",name:"",classId:"options"});
  var [eventsReloadKey,setEventsReloadKey]=useState(0);
  var fileInputRef=useRef(null);
  var pasteTextRef=useRef(null);
  var [showPaste,setShowPaste]=useState(false);
  var [pasteText,setPasteText]=useState("");
  var backupRef=useRef(null);
  var [backupModal,setBackupModal]=useState(null);
  var [checklistItems,setChecklistItems]=useState(loadChecklistItems());
  var [conditionsItems,setConditionsItems]=useState(loadConditionsItems());
  var [newConditionsItem,setNewConditionsItem]=useState({label:"",inverted:false});
  var [newChecklistItem,setNewChecklistItem]=useState({label:"",cat:"Mental",inverted:false});
  var [discScoring,setDiscScoring]=useState(loadDisciplineScoring());
  var [lockThreshold,setLockThreshold]=useState(loadDisciplineLockThreshold());
  var [scaleOpen,setScaleOpen]=useState(false);
  // CHANGED: Pre-trade checklist state for the Settings editor.
  var [pretradeMap,setPretradeMap]=useState(loadPretradeChecklist());
  var [pretradeEditClass,setPretradeEditClass]=useState((settings&&settings.defaultAssetClass)||"options");
  var [pretradeFilterSetup,setPretradeFilterSetup]=useState("");
  var [newPretradeItem,setNewPretradeItem]=useState({label:"",cat:"",inverted:false,setup:""});
  function persistPretrade(map){setPretradeMap(map);savePretradeChecklist(map);}
  // CHANGED: Two-step inline confirm for reset-to-default actions (avoids confirm() which can fail on mobile).
  var [resetConfirm,setResetConfirm]=useState(null); // null | "checklist" | "discScoring"
  function persistChecklist(items){setChecklistItems(items);saveChecklistItems(items);if(props.onChecklistChange)props.onChecklistChange();}
  function persistDiscScoring(ds){setDiscScoring(ds);saveDisciplineScoring(ds);}
  // CHANGED: Normal accounting — Deposit = +$ (adds to balance), Withdrawal = -$ (subtracts). Account balance now reflects actual capital.
  function addTransfer(){
    var rawAmt=parseFloat(transferDraft.amount);
    if(isNaN(rawAmt)||rawAmt===0)return;
    var signed=transferDraft.type==="deposit"?Math.abs(rawAmt):-Math.abs(rawAmt);
    var t={id:Date.now(),date:transferDraft.date,type:transferDraft.type||"withdrawal",amount:signed,note:transferDraft.note||""};
    var nt=transfers.concat([t]);
    setTransfers(nt);saveTransfers(nt);
    setTransferDraft(function(d){return Object.assign({},d,{amount:"",note:""});});
  }
  function delTransfer(id){var nt=transfers.filter(function(t){return t.id!==id;});setTransfers(nt);saveTransfers(nt);}
  function importEventsFromText(text){
    try{
      var data=JSON.parse(text);
      if(!Array.isArray(data)){if(data&&Array.isArray(data.events))data=data.events;else throw new Error("Expected JSON array of events");}
      saveEventsWithMeta(data);setEventsReloadKey(function(k){return k+1;});
      alert("Imported "+data.length+" events");
    }catch(e){alert("Import failed: "+e.message);}
  }
  function backupAll(){
    var dump={};
    try{
      // CHANGED: Only export the app's own keys (tf-* and journal:*). Earlier exports included
      // sb-* Supabase session tokens which, on import to another device, would overwrite the
      // destination's auth session and sign the user out. Filter at the source instead.
      for(var i=0;i<localStorage.length;i++){
        var k=localStorage.key(i);
        if(k&&(k.startsWith("tf-")||k.startsWith("journal:")))dump[k]=localStorage.getItem(k);
      }
    }catch(e){alert("Could not read storage: "+(e.message||e));return;}
    var json=JSON.stringify(dump,null,2);
    // CHANGED: Filename uses LOCAL date, not UTC. toISOString() returns UTC, which silently
    // rolls to "tomorrow" anytime after ~4pm Pacific — confusing when exporting in the evening.
    var nowL=new Date();
    var ymd=nowL.getFullYear()+"-"+String(nowL.getMonth()+1).padStart(2,"0")+"-"+String(nowL.getDate()).padStart(2,"0");
    var filename="tf-backup-"+ymd+".json";
    // Try the standard download path first.
    try{
      var blob=new Blob([json],{type:"application/json"});
      var url=URL.createObjectURL(blob);
      var a=document.createElement("a");
      a.href=url;a.download=filename;a.style.display="none";
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},100);
      return;
    }catch(e){/* fall through to fallback */}
    // Fallback: copy to clipboard so user can paste into a file or save manually.
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(json).then(function(){
          alert("Download blocked in this view. Backup JSON copied to clipboard — paste into a text file and save as \""+filename+"\".");
        },function(err){
          showBackupModal(json,filename,"Could not copy automatically. Select all and copy manually.");
        });
        return;
      }
    }catch(e){/* ignore */}
    // Last resort: show modal with the JSON to copy
    showBackupModal(json,filename,"Copy this JSON and save as \""+filename+"\".");
  }
  function showBackupModal(json,filename,note){
    setBackupModal({json:json,filename:filename,note:note});
  }
  function restoreFromFile(file){
    var reader=new FileReader();
    reader.onload=function(e){
      try{var data=JSON.parse(e.target.result);if(!data||typeof data!=="object")throw new Error("Invalid backup");
        if(!confirm("This will overwrite all your data. Continue?"))return;
        // CHANGED: write each key tolerantly. Large screenshot-heavy days may exceed the
        // localStorage quota; we still want the rest to load, and (when signed in) the cloud
        // push uploads images to Storage and rewrites local entries to small paths.
        var quotaHit=false;
        // CHANGED: only restore app keys. Backups can contain `sb-*` Supabase session tokens (and
        // any other non-tf cruft); writing those overwrites the current logged-in session and
        // signs the user out. Limit to recognized app keys only.
        function isAppKey(k){return typeof k==="string"&&(k.startsWith("tf-")||k.startsWith("journal:"));}
        Object.keys(data).forEach(function(k){if(!isAppKey(k))return;try{localStorage.setItem(k,data[k]);}catch(err){quotaHit=true;}});
        if(typeof window!=="undefined"&&typeof window.__psychoSyncRestore==="function"){
          alert("Restore complete. Uploading to your account (including screenshots)…");
          window.__psychoSyncRestore(data).then(function(){window.location.reload();},function(err){alert("Restored, but cloud upload had an issue: "+(err&&err.message?err.message:err)+". Reloading anyway.");window.location.reload();});
        }else if(quotaHit){
          alert("Restored, but some screenshots were too large for offline storage. Sign in to store them in the cloud. Reloading...");window.location.reload();
        }else{
          alert("Restore complete. Reloading...");window.location.reload();
        }
      }catch(e){alert("Restore failed: "+e.message);}
    };
    reader.readAsText(file);
  }
  function clearAll(){
    if(!confirm("Clear ALL data? This cannot be undone."))return;
    if(!confirm("Are you absolutely sure? This will delete every trade, journal, and setting."))return;
    // CHANGED: Wipe cloud too. Previously only localStorage was cleared and the next page-load
    // pulled today's data back from Supabase, making the button look broken.
    function reset(){localStorage.clear();window.location.reload();}
    if(typeof window!=="undefined"&&typeof window.__psychoSyncWipe==="function"){
      window.__psychoSyncWipe().then(reset,function(err){console.error("Cloud wipe failed:",err);reset();});
    }else{reset();}
  }
  var sessions=getSessions(settings);
  // CHANGED: 2-week strategy lock check. When active, all session mutations are no-ops.
  function isStrategyLocked(){
    var LOCK_MS=14*24*60*60*1000;
    var t=parseFloat(settings.sessionStrategyLockedAt)||0;
    return t>0&&(Date.now()-t)<LOCK_MS;
  }
  function updateSession(idx,patch){
    if(isStrategyLocked())return;
    var ns=sessions.slice();ns[idx]=Object.assign({},ns[idx],patch);
    setSettings(function(s){return Object.assign({},s,{sessions:ns});});
  }
  function toggleSessionDay(idx,day){
    if(isStrategyLocked())return;
    var s=sessions[idx];var days=(s.days||[1,2,3,4,5]).slice();
    var i=days.indexOf(day);
    if(i>=0)days.splice(i,1);else days.push(day);
    days.sort();
    updateSession(idx,{days:days});
  }
  // CHANGED: Add/delete session helpers.
  function addSession(){
    if(isStrategyLocked())return;
    var newSess={id:"custom_"+Date.now(),name:"New Session",startMin:540,endMin:600,enabled:true,sizeFraction:1,maxTrades:99,notes:"",color:"#22c55e",days:[1,2,3,4,5]};
    var ns=sessions.concat([newSess]);
    setSettings(function(s){return Object.assign({},s,{sessions:ns});});
  }
  // CHANGED: Remove confirm() — silent on mobile. Clicking × is the explicit confirmation.
  function deleteSession(idx){
    if(isStrategyLocked())return;
    var ns=sessions.filter(function(_,xi){return xi!==idx;});
    setSettings(function(s){return Object.assign({},s,{sessions:ns});});
  }
  // CHANGED: Home Focus panel editor — per day-state (red/green/neutral) title, items, enabled.
  function updateFocusState(stateKey,patch){
    setSettings(function(s){
      var fs=getFocusStates(s);
      fs[stateKey]=Object.assign({},fs[stateKey],patch);
      return Object.assign({},s,{focusStates:fs});
    });
  }
  return (
    <div style={{paddingTop:16}}>
      <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",marginBottom:14}}>Settings</div>

      {/* CHANGED: How-to-use guide as the first (collapsible) settings section. */}
      <SettingsSection title="How to Use This App">
        <HelpGuide/>
      </SettingsSection>

      <SettingsSection title="Balance" forceOpen={!!props.initialTransferAmount}>
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Your balance is calculated from transfers + lifetime P&L (including today's live trades). Deposits add to balance, withdrawals subtract.</div>
        {(function(){
          var balance=computeAccountBalance(props.liveTotalPnL);
          // CHANGED: Lifetime deposit + withdrawal totals so the user can see flow at a glance.
          var totalDep=0,totalWdr=0;
          (transfers||[]).forEach(function(t){var a=parseFloat(t.amount)||0;if(a>=0)totalDep+=a;else totalWdr+=Math.abs(a);});
          var fmtUSD=function(n){return "$"+Math.round(n).toLocaleString("en-US");};
          return (
            <>
              <div style={{marginBottom:8,padding:"10px 12px",background:"#0a0a0f",border:"1px solid #4338ca",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:11,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Current Balance</span>
                <span style={{fontSize:20,fontWeight:800,color:balance>=0?"#e2e8f0":"#ef4444",fontVariantNumeric:"tabular-nums",letterSpacing:-0.3}}>${balance.toLocaleString("en-US",{maximumFractionDigits:0})}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:8,marginBottom:12}}>
                <div style={{padding:"8px 10px",background:"#0a0a0f",border:"1px solid #7f1d1d",borderRadius:8}}>
                  <div style={{fontSize:10,color:"#fca5a5",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Total Deposits</div>
                  <div style={{fontSize:16,fontWeight:700,color:"#e2e8f0",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{fmtUSD(totalDep)}</div>
                </div>
                <div style={{padding:"8px 10px",background:"#0a0a0f",border:"1px solid #166534",borderRadius:8}}>
                  <div style={{fontSize:10,color:"#86efac",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Total Withdrawals</div>
                  <div style={{fontSize:16,fontWeight:700,color:"#e2e8f0",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{fmtUSD(totalWdr)}</div>
                </div>
              </div>
            </>
          );
        })()}
        {/* CHANGED: Withdrawals are growth-gated — allowance is 30% of profit since last withdrawal. Ranks/points are cosmetic and not referenced here. */}
        {transferDraft.type==="withdrawal"&&(function(){
          var profit=getProfitSinceLastWithdrawal(props.liveTotalPnL);
          var allowance=getWithdrawalAllowance(props.liveTotalPnL);
          var lastDate=getLastWithdrawalDate();
          var entered=Math.abs(parseFloat(transferDraft.amount)||0);
          var overAllowance=allowance>0&&entered>allowance;
          var unlocked=allowance>0;
          var fmt=function(n){return "$"+Math.round(n).toLocaleString();};
          return (
            <div style={{marginBottom:12,padding:"10px 12px",background:unlocked?"#0f1f2a":"#1c1108",border:"1px solid "+(unlocked?"#166534":"#713f12"),borderRadius:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:11,color:unlocked?"#86efac":"#fdba74",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>{unlocked?"Suggested allowance":"No allowance yet"}</span>
                <span style={{fontSize:16,fontWeight:800,color:unlocked?"#22c55e":"#f59e0b"}}>{fmt(allowance)}</span>
              </div>
              <div style={{fontSize:11,color:"#64748b",marginTop:5,lineHeight:1.5}}>
                {WITHDRAWAL_ALLOWANCE_PCT}% of {fmt(Math.max(0,profit))} profit{lastDate?" since last withdrawal":" (all-time)"}
              </div>
              {allowance<=0&&<div style={{fontSize:11,color:"#fdba74",marginTop:5}}>No profit{lastDate?" since your last withdrawal":""} yet, so the suggested allowance is $0. You can still log this — it's just a guide.</div>}
              {overAllowance&&<div style={{fontSize:11,color:"#fca5a5",marginTop:5}}>Over allowance by {fmt(entered-allowance)} — you can still log it, but it exceeds the {WITHDRAWAL_ALLOWANCE_PCT}% guide.</div>}
              {/* CHANGED: Notify-me-at target. When the live allowance reaches this amount, a banner shows on Home. */}
              <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #1e293b44"}}>
                <label style={{fontSize:11,color:"#94a3b8",fontWeight:600,display:"block",marginBottom:5}}>Notify me when allowance reaches</label>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:13,color:"#64748b"}}>$</span>
                  <input type="number" value={allowanceTargetInput} onChange={function(e){setAllowanceTargetInput(e.target.value);}} placeholder="e.g. 500" style={Object.assign({},fld,{flex:1})}/>
                  <button onClick={function(){var v=parseFloat(allowanceTargetInput)||0;saveAllowanceTarget(v);setAllowanceTargetInput(v>0?String(v):"");if(props.bumpReloadKey)props.bumpReloadKey();}} style={{padding:"7px 14px",background:"#4f46e5",border:"none",borderRadius:5,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>Set</button>
                </div>
                {getAllowanceTarget()>0?<div style={{fontSize:11,color:"#86efac",marginTop:6}}>✓ You'll see a banner on Home when your allowance hits {fmt(getAllowanceTarget())}.{" "}<button onClick={function(){saveAllowanceTarget(0);setAllowanceTargetInput("");if(props.bumpReloadKey)props.bumpReloadKey();}} style={{background:"none",border:"none",color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit",textDecoration:"underline",padding:0}}>Clear</button></div>:<div style={{fontSize:11,color:"#64748b",marginTop:6}}>Leave blank for no notification.</div>}
              </div>
            </div>
          );
        })()}
        {/* Type toggle */}
        <div style={{display:"flex",gap:6,marginBottom:8}}>
          {[{id:"deposit",label:"Deposit (+$)",color:"#ef4444",bg:"#7f1d1d"},{id:"withdrawal",label:"Withdrawal (-$)",color:"#22c55e",bg:"#14532d"}].map(function(o){
            var active=transferDraft.type===o.id;
            return <button key={o.id} onClick={function(){setTransferDraft(function(d){return Object.assign({},d,{type:o.id});});}} style={{flex:1,padding:"7px 12px",background:active?o.bg:"#0a0a0f",border:"1px solid "+(active?o.color:"#334155"),borderRadius:5,color:active?"#fff":"#64748b",fontSize:13,fontWeight:active?700:500,cursor:"pointer",fontFamily:"inherit"}}>{o.label}</button>;
          })}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"120px 110px 1fr auto",gap:6,marginBottom:8}}>
          <input type="date" onMouseDown={function(e){var inp=e.currentTarget;setTimeout(function(){try{inp.focus();if(inp.showPicker)inp.showPicker();}catch(err){}},0);}} value={transferDraft.date} onChange={function(e){setTransferDraft(function(d){return Object.assign({},d,{date:e.target.value});});}} style={Object.assign({},fld,{padding:"6px 9px",fontSize:13,colorScheme:"dark",color:"#e2e8f0"})}/>
          <input type="number" min="0" step="0.01" value={transferDraft.amount} onChange={function(e){setTransferDraft(function(d){return Object.assign({},d,{amount:e.target.value});});}} placeholder="$ amount" style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
          <input value={transferDraft.note} onChange={function(e){setTransferDraft(function(d){return Object.assign({},d,{note:e.target.value});});}} placeholder="Note (optional)" style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
          <button onClick={addTransfer} style={{padding:"6px 11px",background:"#4f46e5",border:"none",borderRadius:5,color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>+ Add</button>
        </div>
        {transfers.length===0&&<div style={{fontSize:12,color:"#64748b",fontStyle:"italic",padding:"6px 0"}}>No transfers logged.</div>}
        {transfers.slice().sort(function(a,b){return new Date(b.date)-new Date(a.date);}).map(function(t){
          var typ=t.type||(t.amount>=0?"deposit":"withdrawal");
          var isWith=typ==="withdrawal";
          return (
            <div key={t.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",marginBottom:4,background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:6}}>
              <span style={{fontSize:12,color:"#94a3b8",minWidth:90}}>{t.date}</span>
              <span style={{fontSize:10,padding:"2px 6px",borderRadius:3,background:isWith?"#14532d":"#7f1d1d",color:isWith?"#86efac":"#fca5a5",fontWeight:700,letterSpacing:0.5}}>{isWith?"WITHDRAW":"DEPOSIT"}</span>
              <span style={{fontSize:13,fontWeight:700,color:t.amount>=0?"#ef4444":"#22c55e",fontVariantNumeric:"tabular-nums"}}>{t.amount>=0?"+":"-"}${Math.abs(t.amount).toFixed(2)}</span>
              <span style={{fontSize:12,color:"#64748b",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.note||""}</span>
              <button onClick={function(){delTransfer(t.id);}} style={{padding:"3px 8px",background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>×</button>
            </div>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Auto-Sizing Parameters">
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Position Max % is the cap on a single trade as a % of your account tier. Risk Max % is the most you'll lose on that trade as a % of its position size. Slippage % defines a minimum (lower bound) for both.</div>
        {/* CHANGED: $ / % mode toggle. */}
        <div style={{display:"flex",gap:6,marginBottom:12}}>
          {[{id:"pct",label:"% of Balance"},{id:"dollar",label:"Fixed $"}].map(function(o){
            var active=(settings.sizingMode||"pct")===o.id;
            return <button key={o.id} onClick={function(){setSettings(function(s){return Object.assign({},s,{sizingMode:o.id});});}} style={{flex:1,padding:"7px 12px",background:active?"#1e1b4b":"#0a0a0f",border:"1px solid "+(active?"#4338ca":"#334155"),borderRadius:5,color:active?"#a5b4fc":"#64748b",fontSize:13,fontWeight:active?700:500,cursor:"pointer",fontFamily:"inherit"}}>{o.label}</button>;
          })}
        </div>
        {(settings.sizingMode||"pct")==="pct"?(
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:8,marginBottom:8}}>
            <div><label style={lbl}>Slippage %</label><input type="number" step="0.1" value={settings.slippagePct!=null?settings.slippagePct:20} onChange={function(e){setSettings(function(s){return Object.assign({},s,{slippagePct:parseFloat(e.target.value)||0});});}} style={fld}/></div>
            <div><label style={lbl}>Position Max %</label><input type="number" step="0.1" value={settings.positionMaxPct!=null?settings.positionMaxPct:7.5} onChange={function(e){setSettings(function(s){return Object.assign({},s,{positionMaxPct:parseFloat(e.target.value)||0});});}} style={fld}/></div>
            <div><label style={lbl}>Risk Max % of Pos</label>
              {/* CHANGED: Helper readout now sits INSIDE the textbox, right-aligned and matched
                 to the input's 15px size — reads like an inline unit/suffix instead of a separate row. */}
              <div style={{position:"relative"}}>
                <input type="number" step="0.1" value={settings.riskMaxPct!=null?settings.riskMaxPct:33} onChange={function(e){setSettings(function(s){return Object.assign({},s,{riskMaxPct:parseFloat(e.target.value)||0});});}} style={Object.assign({},fld,{paddingRight:170})}/>
                <div style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:15,color:"#475569",fontWeight:500,pointerEvents:"none",fontFamily:"inherit"}}>= {((parseFloat(settings.positionMaxPct)||0)*(parseFloat(settings.riskMaxPct)||0)/100).toFixed(2)}% of account</div>
              </div>
            </div>
          </div>
        ):(
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:8,marginBottom:8}}>
            <div><label style={lbl}>Slippage %</label><input type="number" step="0.1" value={settings.slippagePct!=null?settings.slippagePct:20} onChange={function(e){setSettings(function(s){return Object.assign({},s,{slippagePct:parseFloat(e.target.value)||0});});}} style={fld}/></div>
            <div><label style={lbl}>Position Max ($)</label><input type="number" step="1" value={settings.positionMaxDollar!=null?settings.positionMaxDollar:500} onChange={function(e){setSettings(function(s){return Object.assign({},s,{positionMaxDollar:parseFloat(e.target.value)||0});});}} style={fld}/></div>
            <div><label style={lbl}>Risk Max ($)</label><input type="number" step="1" value={settings.riskMaxDollar!=null?settings.riskMaxDollar:165} onChange={function(e){setSettings(function(s){return Object.assign({},s,{riskMaxDollar:parseFloat(e.target.value)||0});});}} style={fld}/></div>
          </div>
        )}
        <div style={{fontSize:12,color:"#94a3b8",marginTop:4,padding:"6px 10px",background:"#0a0a0f",borderRadius:6,border:"1px solid #1e293b"}}>
          Computed: Position ${settings.positionMin}–${settings.positionMax} · Risk ${settings.riskMin}–${settings.riskMax}
        </div>
        {/* CHANGED: Scale milestones table — shows position/risk at each $1k tier with 5% buffer. */}
        {(function(){
          var balance=computeAccountBalance(props.liveTotalPnL);
          var slip=settings.slippagePct!=null?settings.slippagePct:20;
          var posMaxPct=settings.positionMaxPct!=null?settings.positionMaxPct:7.5;
          var riskMaxPct=settings.riskMaxPct!=null?settings.riskMaxPct:33;
          // CHANGED: Tier schedule — $1k steps up to $10k, then $5k steps to $20k (so $15k and
          // $20k are included), then $10k steps to $100k. Keeps early scaling fine-grained where
          // it matters and stretches out the larger bands.
          var milestones=[500];
          for(var k=1;k<=10;k++)milestones.push(k*1000);
          milestones.push(15000);
          milestones.push(20000);
          for(var m10=30000;m10<=100000;m10+=10000)milestones.push(m10);
          // Find current tier (highest milestone where balance > tier*1.05).
          var currentTier=500;milestones.forEach(function(m){if(balance>m*1.05)currentTier=m;});
          return (
            <div style={{marginTop:8,padding:"8px 10px",background:"#0a0a0f",border:"1px solid #4338ca44",borderRadius:6}}>
              <button onClick={function(){setScaleOpen(function(o){return !o;});}} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",background:"transparent",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",marginBottom:scaleOpen?8:0}}>
                <div style={{fontSize:11,color:"#a5b4fc",letterSpacing:1,textTransform:"uppercase",fontWeight:700}}>Scale Milestones</div>
                <div style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#94a3b8"}}>
                  <span>Current: ${currentTier.toLocaleString()}</span>
                  <span style={{fontSize:10}}>{scaleOpen?"▴":"▾"}</span>
                </div>
              </button>
              {scaleOpen&&(
                <div>
                  <div style={{fontSize:10,color:"#94a3b8",marginBottom:8,lineHeight:1.5,padding:"6px 8px",background:"#0f0f17",border:"1px solid #1e293b",borderRadius:4}}>
                    <div style={{color:"#cbd5e1",fontWeight:600,marginBottom:3}}>Formula (current settings):</div>
                    <div style={{color:"#64748b",marginBottom:4,fontSize:9.5,lineHeight:1.4}}>Tiers step by $1k up to $10k, then $5k up to $20k, then $10k after — size holds steady across each band so you don't scale up too soon.</div>
                    {(settings.sizingMode||"pct")==="pct"?(
                      <div>
                        Pos Max = Tier × <span style={{color:"#a5b4fc"}}>{posMaxPct}%</span> · Pos Min = Pos Max × (1 − <span style={{color:"#a5b4fc"}}>{slip}%</span>)<br/>
                        Risk Max = Pos Max × <span style={{color:"#a5b4fc"}}>{riskMaxPct}%</span> · Risk Min = Risk Max × (1 − <span style={{color:"#a5b4fc"}}>{slip}%</span>)
                      </div>
                    ):(
                      <div>
                        Pos Max = <span style={{color:"#a5b4fc"}}>${settings.positionMaxDollar}</span> (fixed) · Pos Min = Pos Max × (1 − <span style={{color:"#a5b4fc"}}>{slip}%</span>)<br/>
                        Risk Max = <span style={{color:"#a5b4fc"}}>${settings.riskMaxDollar}</span> (fixed) · Risk Min = Risk Max × (1 − <span style={{color:"#a5b4fc"}}>{slip}%</span>)
                      </div>
                    )}
                  </div>
                  {/* CHANGED: Show 7 tiers at a time in a scroll window; current tier auto-centers
                     when the section opens via a ref-and-scroll effect. User can scroll the
                     window itself to see milestones above/below the visible band. */}
                  <ScaleMilestonesScroller currentTier={currentTier}>
                    <div style={{display:"grid",gridTemplateColumns:"auto 1fr 1fr",gap:6,fontSize:11,alignItems:"center"}}>
                      {milestones.map(function(m){
                        var sizes=calcPosSizes(m,{useDirect:true,sizingMode:settings.sizingMode,slippagePct:slip,positionMaxPct:posMaxPct,riskMaxPct:riskMaxPct,positionMaxDollar:settings.positionMaxDollar,riskMaxDollar:settings.riskMaxDollar});
                        var isCurrent=m===currentTier;
                        var isReached=balance>m*1.05;
                        var color=isCurrent?"#86efac":(isReached?"#64748b":"#cbd5e1");
                        var bg=isCurrent?"#0a1f10":"transparent";
                        return [
                          <div key={m+"-t"} data-tier={m} style={{padding:"4px 6px",background:bg,borderRadius:3,fontWeight:isCurrent?700:500,color:color}}>${m.toLocaleString()}{isCurrent?" ←":""}</div>,
                          <div key={m+"-p"} style={{padding:"4px 6px",background:bg,borderRadius:3,color:color}}>${sizes.positionMin}–${sizes.positionMax}</div>,
                          <div key={m+"-r"} style={{padding:"4px 6px",background:bg,borderRadius:3,color:color}}>${sizes.riskMin}–${sizes.riskMax}</div>
                        ];
                      })}
                    </div>
                  </ScaleMilestonesScroller>
                </div>
              )}
            </div>
          );
        })()}
      </SettingsSection>

      <SettingsSection title="Discipline Scoring">
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Customize how points are awarded or deducted from your daily discipline score (starts at 100).</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:8}}>
          <div><label style={lbl}>Violation Penalty</label><input type="number" value={discScoring.violationPenalty} onChange={function(e){persistDiscScoring(Object.assign({},discScoring,{violationPenalty:parseFloat(e.target.value)||0}));}} style={fld}/></div>
          <div><label style={lbl}>Negative Emotion Penalty</label><input type="number" value={discScoring.negEmotionPenalty} onChange={function(e){persistDiscScoring(Object.assign({},discScoring,{negEmotionPenalty:parseFloat(e.target.value)||0}));}} style={fld}/></div>
          <div><label style={lbl}>Positive Emotion Bonus</label><input type="number" value={discScoring.posEmotionBonus} onChange={function(e){persistDiscScoring(Object.assign({},discScoring,{posEmotionBonus:parseFloat(e.target.value)||0}));}} style={fld}/></div>
          <div><label style={lbl}>A-Grade Bonus</label><input type="number" value={discScoring.aGradeBonus} onChange={function(e){persistDiscScoring(Object.assign({},discScoring,{aGradeBonus:parseFloat(e.target.value)||0}));}} style={fld}/></div>
          <div><label style={lbl}>C-Grade Penalty</label><input type="number" value={discScoring.cGradePenalty} onChange={function(e){persistDiscScoring(Object.assign({},discScoring,{cGradePenalty:parseFloat(e.target.value)||0}));}} style={fld}/></div>
          <div><label style={lbl}>Over-Commitment Penalty</label><input type="number" value={discScoring.overTradePenalty!=null?discScoring.overTradePenalty:10} onChange={function(e){persistDiscScoring(Object.assign({},discScoring,{overTradePenalty:parseFloat(e.target.value)||0}));}} style={fld}/></div>
          <div><label style={lbl}>Setup Deviation Penalty</label><input type="number" value={discScoring.setupDeviationPenalty!=null?discScoring.setupDeviationPenalty:10} onChange={function(e){persistDiscScoring(Object.assign({},discScoring,{setupDeviationPenalty:parseFloat(e.target.value)||0}));}} style={fld}/></div>
        </div>
        <div style={{fontSize:11,color:"#64748b",marginTop:8,lineHeight:1.5}}>Over-Commitment applies when you exceed your committed max trades; Setup Deviation applies when you mark "No, I deviated" in the day's Commitment Review. Both also forfeit the winning-day bonus.</div>
        {resetConfirm==="discScoring"?(
          <div style={{marginTop:10,display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:12,color:"#fdba74",fontWeight:600}}>Reset to defaults?</span>
            <button onClick={function(){persistDiscScoring(Object.assign({},DEFAULT_DISCIPLINE_SCORING));setResetConfirm(null);}} style={{padding:"5px 12px",background:"#7f1d1d",border:"1px solid #ef4444",borderRadius:5,color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Yes, reset</button>
            <button onClick={function(){setResetConfirm(null);}} style={{padding:"5px 12px",background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          </div>
        ):(
          <button onClick={function(){setResetConfirm("discScoring");}} style={{marginTop:10,padding:"5px 12px",background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Reset to defaults</button>
        )}
        <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #1e293b"}}>
          <label style={lbl}>Discipline Lock Threshold</label>
          <input type="number" min="0" max="100" value={lockThreshold} onChange={function(e){var v=parseFloat(e.target.value);if(isNaN(v))return;setLockThreshold(v);saveDisciplineLockThreshold(v);}} style={fld}/>
          <div style={{fontSize:11,color:"#94a3b8",marginTop:6,lineHeight:1.5}}>If a day's discipline score falls below this, new trades are blocked (same day, and the next trading day) until you write a reflection. Auto-clears after the day passes. Set to 0 to disable.</div>
        </div>
      </SettingsSection>

      <SettingsSection title="Asset Classes & Instruments">
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Enable the asset classes you trade. Add instruments under each enabled class to pre-fill them in the trade form.</div>
        {ASSET_CLASS_ORDER.map(function(c){
          var enabled=(settings.enabledAssetClasses||{})[c];
          var classInsts=instruments.filter(function(it){return it.classId===c;});
          return (
            <div key={c} style={{marginBottom:10,background:"#0a0a0f",border:"1px solid "+(enabled?"#1e293b":"#1e293b66"),borderRadius:8,overflow:"hidden"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"10px 12px",borderBottom:enabled?"1px solid #1e293b":"none"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <ToggleSwitch checked={!!enabled} onChange={function(v){setSettings(function(s){var ec=Object.assign({},s.enabledAssetClasses||{});ec[c]=v;return Object.assign({},s,{enabledAssetClasses:ec});});}}/>
                  <span style={{fontSize:14,fontWeight:600,color:enabled?"#e2e8f0":"#64748b"}}>{ASSET_CLASSES[c].label}</span>
                </div>
                {enabled&&classInsts.length>0&&<span style={{fontSize:11,color:"#94a3b8"}}>{classInsts.length} instrument{classInsts.length===1?"":"s"}</span>}
              </div>
              {enabled&&(
                <div style={{padding:"8px 12px"}}>
                  {/* Form Field Toggles */}
                  {(function(){var fs=getFormSectionsForClass(settings,c);var toggle=function(key,v){setSettings(function(s){var acs=Object.assign({},s.assetClassSettings||{});var cur=Object.assign({},acs[c]||{});var sec=Object.assign({},defaultFormSections(),cur.formSections||{});sec[key]=v;cur.formSections=sec;acs[c]=cur;return Object.assign({},s,{assetClassSettings:acs});});};return (
                    <div style={{marginBottom:10,padding:"8px 10px",background:"#0a0a0f",border:"1px solid #1e293b",borderRadius:5}}>
                      <div style={{fontSize:10,color:"#94a3b8",letterSpacing:1,textTransform:"uppercase",fontWeight:700,marginBottom:6}}>Optional Fields</div>
                      <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
                        <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:"#cbd5e1"}}>
                          <input type="checkbox" checked={fs.timeframe!==false} onChange={function(e){toggle("timeframe",e.target.checked);}} style={{cursor:"pointer"}}/>
                          Timeframe
                        </label>
                        <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:"#cbd5e1"}}>
                          <input type="checkbox" checked={fs.candlePattern!==false} onChange={function(e){toggle("candlePattern",e.target.checked);}} style={{cursor:"pointer"}}/>
                          Candle Pattern
                        </label>
                        <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:"#cbd5e1"}}>
                          <input type="checkbox" checked={fs.indicators!==false} onChange={function(e){toggle("indicators",e.target.checked);}} style={{cursor:"pointer"}}/>
                          Indicators
                        </label>
                      </div>
                    </div>
                  );})()}
                  {classInsts.map(function(it){
                    var instIdx=instruments.indexOf(it);
                    // CHANGED: per-class default instrument star toggle.
                    var isDefault=settings.defaultInstruments&&settings.defaultInstruments[c]===it.symbol;
                    return (
                      <div key={instIdx} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 9px",marginBottom:4,background:"#0a0a0f",border:"1px solid "+(isDefault?"#4338ca":"#1e293b"),borderRadius:5}}>
                        <button onClick={function(){
                          setSettings(function(s){
                            var di=Object.assign({},s.defaultInstruments||{});
                            if(di[c]===it.symbol)delete di[c];
                            else di[c]=it.symbol;
                            return Object.assign({},s,{defaultInstruments:di});
                          });
                        }} aria-label={isDefault?"Unset default":"Set as default"} title={isDefault?"Unset default":"Set as default"} style={{padding:"1px 5px",background:"transparent",border:"none",color:isDefault?"#fbbf24":"#475569",fontSize:13,cursor:"pointer",fontFamily:"inherit",lineHeight:1,flexShrink:0}}>{isDefault?"★":"☆"}</button>
                        <span style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>{it.symbol}</span>
                        {isDefault&&<span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:"#1e1b4b",color:"#a5b4fc",fontWeight:700,letterSpacing:0.5}}>DEFAULT</span>}
                        {it.name&&<span style={{fontSize:12,color:"#94a3b8",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.name}</span>}
                        <button onClick={function(){
                          var ni=instruments.filter(function(_,xi){return xi!==instIdx;});
                          setInstruments(ni);saveInstruments(ni);
                          // Clear default if it was this instrument
                          if(isDefault){setSettings(function(s){var di=Object.assign({},s.defaultInstruments||{});delete di[c];return Object.assign({},s,{defaultInstruments:di});});}
                        }} aria-label="Delete instrument" style={{padding:"2px 7px",background:"transparent",border:"1px solid #334155",borderRadius:4,color:"#64748b",fontSize:11,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>×</button>
                      </div>
                    );
                  })}
                  {/* Add-instrument form for THIS asset class */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:6,marginTop:6,alignItems:"end"}}>
                    <div><label style={lbl}>Symbol</label><input value={newInst.classId===c?newInst.symbol:""} onChange={function(e){setNewInst({classId:c,symbol:e.target.value.toUpperCase(),name:newInst.classId===c?newInst.name:""});}} placeholder="SPY" style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#e2e8f0"})}/></div>
                    <div><label style={lbl}>Name (optional)</label><input value={newInst.classId===c?newInst.name:""} onChange={function(e){setNewInst({classId:c,symbol:newInst.classId===c?newInst.symbol:"",name:e.target.value});}} placeholder="S&P 500 ETF" style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#e2e8f0"})}/></div>
                    <button onClick={function(){if(newInst.classId!==c||!newInst.symbol.trim())return;var ni=instruments.concat([{symbol:newInst.symbol.trim(),name:newInst.name.trim(),classId:c}]);setInstruments(ni);saveInstruments(ni);setNewInst({symbol:"",name:"",classId:c});}} style={{padding:"5px 10px",background:"#4f46e5",border:"none",borderRadius:4,color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>+ Add</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Pre-Market Checklist">
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Add, edit, or remove pre-market checklist items. Inverted items must be unchecked to pass. Configure "Conditions Checklist" separately below.</div>
        {/* CHANGED: Column headers so the bare toggle column has context. */}
        {checklistItems.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:"auto 1fr 100px auto",gap:6,marginBottom:6,alignItems:"center",paddingBottom:6,borderBottom:"1px solid #1e293b"}}>
            <span style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Invert</span>
            <span style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Item</span>
            <span style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Category</span>
            <span/>
          </div>
        )}
        {checklistItems.map(function(item,i){
          return (
            <div key={item.key} style={{display:"grid",gridTemplateColumns:"auto 1fr 100px auto",gap:6,marginBottom:6,alignItems:"center"}}>
              <ToggleSwitch checked={!!item.inverted} onChange={function(v){var ns=checklistItems.map(function(x){return x.key===item.key?Object.assign({},x,{inverted:v}):x;});persistChecklist(ns);}}/>
              <input value={item.label} onChange={function(e){var v=e.target.value;var ns=checklistItems.map(function(x){return x.key===item.key?Object.assign({},x,{label:v}):x;});persistChecklist(ns);}} style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
              <input value={item.cat} onChange={function(e){var v=e.target.value;var ns=checklistItems.map(function(x){return x.key===item.key?Object.assign({},x,{cat:v}):x;});persistChecklist(ns);}} placeholder="Category" style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
              <button onClick={function(){
                // CHANGED: Use functional setter to read latest state and avoid stale-closure issues.
                var keyToDelete=item.key;
                setChecklistItems(function(prev){
                  var ns=prev.filter(function(x){return x.key!==keyToDelete;});
                  saveChecklistItems(ns);
                  if(props.onChecklistChange)props.onChecklistChange();
                  return ns;
                });
              }} aria-label={"Delete "+item.label} title="Delete" style={{padding:"5px 9px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:4,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>
            </div>
          );
        })}
        <div style={{display:"grid",gridTemplateColumns:"auto 1fr 100px auto",gap:6,marginTop:10,paddingTop:10,borderTop:"1px solid #1e293b",alignItems:"center"}}>
          <ToggleSwitch checked={!!newChecklistItem.inverted} onChange={function(v){setNewChecklistItem(function(d){return Object.assign({},d,{inverted:v});});}}/>
          <input value={newChecklistItem.label} onChange={function(e){setNewChecklistItem(function(d){return Object.assign({},d,{label:e.target.value});});}} placeholder="New item label..." style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
          <input value={newChecklistItem.cat} onChange={function(e){setNewChecklistItem(function(d){return Object.assign({},d,{cat:e.target.value});});}} placeholder="Category" style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
          <button onClick={function(){
            // CHANGED: Build the new array from current state without side effects in the updater.
            var label=(newChecklistItem.label||"").trim();
            if(!label)return;
            var newItem={key:"custom_"+Date.now()+"_"+Math.random().toString(36).slice(2,6),label:label,cat:newChecklistItem.cat||"Other",inverted:!!newChecklistItem.inverted};
            var ns=(checklistItems||[]).concat([newItem]);
            setChecklistItems(ns);
            saveChecklistItems(ns);
            if(props.onChecklistChange)props.onChecklistChange();
            setNewChecklistItem({label:"",cat:"Mental",inverted:false});
          }} style={{padding:"5px 9px",background:"#4f46e5",border:"none",borderRadius:4,color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>+ Add</button>
        </div>
        {resetConfirm==="checklist"?(
          <div style={{marginTop:10,display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:12,color:"#fdba74",fontWeight:600}}>Reset to defaults?</span>
            <button onClick={function(){persistChecklist(DEFAULT_CHECKLIST_ITEMS.slice());setResetConfirm(null);}} style={{padding:"5px 12px",background:"#7f1d1d",border:"1px solid #ef4444",borderRadius:5,color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Yes, reset</button>
            <button onClick={function(){setResetConfirm(null);}} style={{padding:"5px 12px",background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          </div>
        ):(
          <button onClick={function(){setResetConfirm("checklist");}} style={{marginTop:10,padding:"5px 12px",background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Reset to defaults</button>
        )}
      </SettingsSection>

      {/* CHANGED: Conditions Checklist removed — the feature blocked the trade button without
         enough utility to justify the extra cognitive load. State and storage left in place
         so legacy entries with conditionsChecked keys don't crash; new entries simply ignore it. */}

      <SettingsSection title="Session Strategy">
        {(function(){
          var LOCK_MS=14*24*60*60*1000;
          var lockedAt=parseFloat(settings.sessionStrategyLockedAt)||0;
          var now=Date.now();
          var locked=lockedAt>0&&(now-lockedAt)<LOCK_MS;
          var daysLeft=locked?Math.ceil((LOCK_MS-(now-lockedAt))/(24*60*60*1000)):0;
          var unlockDate=locked?new Date(lockedAt+LOCK_MS):null;
          function lockNow(){setSettings(function(s){return Object.assign({},s,{sessionStrategyLockedAt:Date.now()});});}
          // Expose lock state to surrounding closure via window-scoped var on settings for input handlers.
          settings.__strategyLocked=locked;
          if(locked){
            return (
              <div style={{marginBottom:12,padding:"10px 12px",background:"#1e1b4b33",border:"1px solid #4338ca",borderRadius:8,display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>🔒</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,color:"#a5b4fc",fontWeight:700,letterSpacing:0.5}}>Strategy locked · {daysLeft} day{daysLeft===1?"":"s"} remaining</div>
                  <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>Unlocks {unlockDate.toLocaleDateString([],{weekday:"short",month:"short",day:"numeric"})}. Commit to your plan — no edits until then.</div>
                </div>
              </div>
            );
          }
          return (
            <div style={{marginBottom:12,padding:"10px 12px",background:"#0a0a0f",border:"1px dashed #334155",borderRadius:8,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:16}}>🔓</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,color:"#cbd5e1",fontWeight:600}}>Strategy unlocked</div>
                <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>Lock your strategy to enforce a 2-week commitment.</div>
              </div>
              <button onClick={lockNow} style={{padding:"6px 12px",background:"#4338ca",border:"none",borderRadius:6,color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Lock 2 weeks</button>
            </div>
          );
        })()}
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Configure each session's hours, sizing, max trades, and active days. Add custom sessions or delete unused ones.</div>
        {sessions.map(function(s,idx){
          var days=s.days||[1,2,3,4,5];
          var disabled=isStrategyLocked();
          var dFld=disabled?{opacity:0.55,pointerEvents:"none"}:{};
          return (
            <div key={s.id} style={{padding:"10px 12px",marginBottom:8,background:"#0a0a0f",border:"1px solid "+(s.enabled?"#1e293b":"#7f1d1d33"),borderRadius:8,opacity:disabled?0.85:1}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                  <div style={dFld}><ToggleSwitch checked={!!s.enabled} onChange={function(v){updateSession(idx,{enabled:v});}}/></div>
                  <div style={{width:8,height:8,borderRadius:"50%",background:s.color||"#64748b",flexShrink:0}}/>
                  <input disabled={disabled} value={s.name||""} onChange={function(e){updateSession(idx,{name:e.target.value});}} style={Object.assign({},fld,{padding:"5px 9px",fontSize:13,fontWeight:600},dFld)}/>
                </div>
                <button onClick={function(){deleteSession(idx);}} disabled={disabled} aria-label="Delete session" title={disabled?"Strategy locked":"Delete session"} style={{padding:"4px 9px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:4,color:"#fca5a5",fontSize:13,cursor:disabled?"not-allowed":"pointer",fontFamily:"inherit",lineHeight:1,flexShrink:0,opacity:disabled?0.4:1}}>×</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:8}}>
                {/* CHANGED: Time-of-day inputs (HH:MM) instead of raw minutes. */}
                <div><label style={lbl}>Start</label><input disabled={disabled} type="time" value={minsToTimeStr(s.startMin||0)} onChange={function(e){updateSession(idx,{startMin:timeStrToMins(e.target.value)});}} style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#e2e8f0"},dFld)}/></div>
                <div><label style={lbl}>End</label><input disabled={disabled} type="time" value={minsToTimeStr(s.endMin||0)} onChange={function(e){updateSession(idx,{endMin:timeStrToMins(e.target.value)});}} style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#e2e8f0"},dFld)}/></div>
                <div><label style={lbl}>Size %</label><input disabled={disabled} type="number" step="1" min="0" max="100" value={Math.round((s.sizeFraction||1)*100)} onChange={function(e){var pct=parseFloat(e.target.value);if(isNaN(pct))pct=0;updateSession(idx,{sizeFraction:pct/100});}} style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#e2e8f0"},dFld)}/></div>
                <div><label style={lbl}>Max Trades</label><input disabled={disabled} type="number" value={s.maxTrades!=null?s.maxTrades:99} onChange={function(e){updateSession(idx,{maxTrades:parseInt(e.target.value)||0});}} style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#e2e8f0"},dFld)}/></div>
              </div>
              {/* CHANGED: Daily R hard stops. 1R = session-scaled risk (settings.riskMax × sizeFraction), so a 1R stop scales with session size automatically. */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:6,marginBottom:8}}>
                <div>
                  <label style={lbl}>Loss Stop (R)</label>
                  <input disabled={disabled} type="number" step="0.1" value={s.lossStopR!=null?s.lossStopR:-1} onChange={function(e){var v=parseFloat(e.target.value);updateSession(idx,{lossStopR:isNaN(v)?null:v});}} style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#ef4444",fontWeight:600},dFld)}/>
                </div>
                <div>
                  <label style={lbl}>Gain Stop (R)</label>
                  <input disabled={disabled} type="number" step="0.1" value={s.gainStopR!=null?s.gainStopR:2.5} onChange={function(e){var v=parseFloat(e.target.value);updateSession(idx,{gainStopR:isNaN(v)?null:v});}} style={Object.assign({},fld,{padding:"5px 8px",fontSize:12,colorScheme:"dark",color:"#22c55e",fontWeight:600},dFld)}/>
                </div>
              </div>
              {/* CHANGED: Per-session default asset class. When set, overrides global default when this session is active. */}
              <div style={{marginBottom:8}}>
                <label style={lbl}>Default Asset Class</label>
                <Dropdown disabled={disabled} value={s.defaultAssetClass||""} onChange={function(v){updateSession(idx,{defaultAssetClass:v||null});}} options={[{v:"",l:"— Use global default —"}].concat(ASSET_CLASS_ORDER.map(function(c){return {v:c,l:ASSET_CLASSES[c].label};}))}/>
              </div>
              {/* Days-of-week selector */}
              <div style={{marginBottom:8}}>
                <label style={lbl}>Active Days</label>
                <div style={Object.assign({display:"flex",gap:4,flexWrap:"wrap"},dFld)}>
                  {DAYS_OF_WEEK.map(function(d){
                    var on=days.indexOf(d.n)>=0;
                    return <button key={d.n} onClick={function(){toggleSessionDay(idx,d.n);}} style={{padding:"5px 10px",background:on?"#1e1b4b":"#0a0a0f",border:"1px solid "+(on?"#4338ca":"#334155"),borderRadius:5,color:on?"#a5b4fc":"#64748b",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{d.short}</button>;
                  })}
                </div>
              </div>
              <div>
                <label style={lbl}>Notes (shown in dashboard)</label>
                <textarea value={s.notes||""} onChange={function(e){updateSession(idx,{notes:e.target.value});}} placeholder="Strategy notes for this session..." style={Object.assign({},fld,{padding:"6px 9px",fontSize:12,minHeight:50,fontFamily:"inherit"})}/>
              </div>
              <div style={{marginTop:8}}>
                <label style={lbl}>Exit Plan (shown at top of new trade form)</label>
                <textarea value={s.exitPlan||""} onChange={function(e){updateSession(idx,{exitPlan:e.target.value});}} placeholder="e.g. Take profit at 1R · trail at break-even after first target · full exit before close" style={Object.assign({},fld,{padding:"6px 9px",fontSize:12,minHeight:50,fontFamily:"inherit"})}/>
              </div>
            </div>
          );
        })}
        {/* CHANGED: Add new session button. */}
        <button onClick={addSession} disabled={isStrategyLocked()} style={{width:"100%",padding:"9px",background:"#1e1b4b",border:"1px dashed #4338ca",borderRadius:6,color:"#a5b4fc",fontSize:13,fontWeight:600,cursor:isStrategyLocked()?"not-allowed":"pointer",fontFamily:"inherit",opacity:isStrategyLocked()?0.4:1}}>+ Add Session</button>
      </SettingsSection>

      <SettingsSection title="Pre-Trade Checklist">
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Per-asset-class checklist shown in the trade form. Assign a Setup to make an item appear only for that setup; leave blank to show for all setups. The form is locked until every visible item is satisfied.</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:8,marginBottom:10}}>
          <div>
            <label style={lbl}>Asset class</label>
            <Dropdown value={pretradeEditClass} onChange={function(v){setPretradeEditClass(v);}} options={ASSET_CLASS_ORDER.map(function(c){return {v:c,l:ASSET_CLASSES[c].label};})}/>
          </div>
          <div>
            <label style={lbl}>Filter by setup</label>
            <Dropdown value={pretradeFilterSetup} onChange={function(v){setPretradeFilterSetup(v);}} options={[{v:"",l:"All items"},{v:"__none__",l:"All setups (unassigned)"}].concat(((tradeOptions&&tradeOptions.setup)||[]).map(function(s){return {v:s,l:s};}))}/>
          </div>
        </div>
        {(function(){
          var allItems=pretradeMap[pretradeEditClass]||[];
          var setupOpts=(tradeOptions&&tradeOptions.setup)||[];
          // CHANGED: Filter items by selected setup.
          // "" = show all · "__none__" = only unassigned · specific setup = that setup PLUS unassigned (all-setups) items, since those apply universally.
          var items=pretradeFilterSetup===""?allItems:(pretradeFilterSetup==="__none__"?allItems.filter(function(it){return !it.setup;}):allItems.filter(function(it){return !it.setup||it.setup===pretradeFilterSetup;}));
          return (
            <div>
              {pretradeFilterSetup!==""&&(
                <div style={{fontSize:11,color:"#a5b4fc",marginBottom:8,fontStyle:"italic"}}>Showing {items.length} of {allItems.length} items{pretradeFilterSetup==="__none__"?" (unassigned only)":" for \""+pretradeFilterSetup+"\" (includes all-setups items)"}</div>
              )}
              {items.length>0&&(
                <div style={{display:"grid",gridTemplateColumns:"auto 1fr 90px 110px auto",gap:6,marginBottom:6,alignItems:"center",paddingBottom:6,borderBottom:"1px solid #1e293b"}}>
                  <span style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Invert</span>
                  <span style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Item</span>
                  <span style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Category</span>
                  <span style={{fontSize:10,color:"#64748b",letterSpacing:1,textTransform:"uppercase",fontWeight:600}}>Setup</span>
                  <span/>
                </div>
              )}
              {items.map(function(item){
                return (
                  <div key={item.key} style={{display:"grid",gridTemplateColumns:"auto 1fr 90px 110px auto",gap:6,marginBottom:6,alignItems:"center"}}>
                    <ToggleSwitch checked={!!item.inverted} onChange={function(v){var ns=allItems.map(function(x){return x.key===item.key?Object.assign({},x,{inverted:v}):x;});var nm=Object.assign({},pretradeMap);nm[pretradeEditClass]=ns;persistPretrade(nm);}}/>
                    <input value={item.label} onChange={function(e){var v=e.target.value;var ns=allItems.map(function(x){return x.key===item.key?Object.assign({},x,{label:v}):x;});var nm=Object.assign({},pretradeMap);nm[pretradeEditClass]=ns;persistPretrade(nm);}} style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
                    <input value={item.cat||""} onChange={function(e){var v=e.target.value;var ns=allItems.map(function(x){return x.key===item.key?Object.assign({},x,{cat:v}):x;});var nm=Object.assign({},pretradeMap);nm[pretradeEditClass]=ns;persistPretrade(nm);}} placeholder="Category" style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
                    <Dropdown value={item.setup||""} onChange={function(v){var ns=allItems.map(function(x){return x.key===item.key?Object.assign({},x,{setup:v}):x;});var nm=Object.assign({},pretradeMap);nm[pretradeEditClass]=ns;persistPretrade(nm);}} options={[{v:"",l:"All setups"}].concat(setupOpts.map(function(s){return {v:s,l:s};}))}/>
                    <button onClick={function(){
                      setPretradeMap(function(prev){
                        var arr=(prev[pretradeEditClass]||[]).filter(function(x){return x.key!==item.key;});
                        var nm=Object.assign({},prev);nm[pretradeEditClass]=arr;
                        savePretradeChecklist(nm);
                        return nm;
                      });
                    }} aria-label={"Delete "+item.label} style={{padding:"5px 9px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:4,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit",lineHeight:1}}>×</button>
                  </div>
                );
              })}
              {items.length===0&&<div style={{fontSize:12,color:"#64748b",fontStyle:"italic",padding:"6px 0"}}>No items yet for this asset class.</div>}
              {/* Add-item row */}
              <div style={{display:"grid",gridTemplateColumns:"auto 1fr 90px 110px auto",gap:6,marginTop:10,paddingTop:10,borderTop:"1px solid #1e293b",alignItems:"center"}}>
                <ToggleSwitch checked={!!newPretradeItem.inverted} onChange={function(v){setNewPretradeItem(function(d){return Object.assign({},d,{inverted:v});});}}/>
                <input value={newPretradeItem.label} onChange={function(e){setNewPretradeItem(function(d){return Object.assign({},d,{label:e.target.value});});}} placeholder="New item label..." style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
                <input value={newPretradeItem.cat} onChange={function(e){setNewPretradeItem(function(d){return Object.assign({},d,{cat:e.target.value});});}} placeholder="Category" style={Object.assign({},fld,{padding:"6px 9px",fontSize:13})}/>
                <Dropdown value={newPretradeItem.setup!==undefined&&newPretradeItem.setup!==""?newPretradeItem.setup:(pretradeFilterSetup&&pretradeFilterSetup!=="__none__"?pretradeFilterSetup:"")} onChange={function(v){setNewPretradeItem(function(d){return Object.assign({},d,{setup:v});});}} options={[{v:"",l:"All setups"}].concat(setupOpts.map(function(s){return {v:s,l:s};}))}/>
                <button onClick={function(){
                  var label=(newPretradeItem.label||"").trim();
                  if(!label)return;
                  // CHANGED: If a setup filter is active, default the new item to that setup.
                  var itemSetup=newPretradeItem.setup||((pretradeFilterSetup&&pretradeFilterSetup!=="__none__")?pretradeFilterSetup:"");
                  var newItem={key:"pt_"+pretradeEditClass+"_"+Date.now()+"_"+Math.random().toString(36).slice(2,6),label:label,cat:newPretradeItem.cat||"",inverted:!!newPretradeItem.inverted,setup:itemSetup};
                  var arr=(pretradeMap[pretradeEditClass]||[]).concat([newItem]);
                  var nm=Object.assign({},pretradeMap);nm[pretradeEditClass]=arr;
                  setPretradeMap(nm);
                  savePretradeChecklist(nm);
                  setNewPretradeItem({label:"",cat:"",inverted:false,setup:""});
                }} style={{padding:"5px 9px",background:"#4f46e5",border:"none",borderRadius:4,color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>+ Add</button>
              </div>
            </div>
          );
        })()}
      </SettingsSection>

      <SettingsSection title="Trade Form Options">
        <OptionsEditor label="Setups" values={tradeOptions.setup} onChange={function(v){var no=Object.assign({},tradeOptions,{setup:v});setTradeOptions(no);saveOptions(no);}}/>
        <OptionsEditor label="Timeframes" values={tradeOptions.timeframe} onChange={function(v){var sorted=sortTimeframes(v);var no=Object.assign({},tradeOptions,{timeframe:sorted});setTradeOptions(no);saveOptions(no);}}/>
        <OptionsEditor label="Candle Patterns" values={tradeOptions.candlePattern} onChange={function(v){var no=Object.assign({},tradeOptions,{candlePattern:v});setTradeOptions(no);saveOptions(no);}}/>
        {/* CHANGED: Indicators editor. */}
        <OptionsEditor label="Indicators" values={tradeOptions.indicator||[]} onChange={function(v){var no=Object.assign({},tradeOptions,{indicator:v});setTradeOptions(no);saveOptions(no);}}/>
        <OptionsEditor label="Emotions" values={tradeOptions.emotion} onChange={function(v){var no=Object.assign({},tradeOptions,{emotion:v});setTradeOptions(no);saveOptions(no);}} sentiments={tradeOptions.emotionSentiments} onSentimentChange={function(ns){var no=Object.assign({},tradeOptions,{emotionSentiments:ns});setTradeOptions(no);saveOptions(no);}}/>
        <OptionsEditor label="Rule Violations" values={tradeOptions.violation} onChange={function(v){var no=Object.assign({},tradeOptions,{violation:v});setTradeOptions(no);saveOptions(no);}}/>
        <div style={{fontSize:11,color:"#64748b",marginTop:-4,marginBottom:8,lineHeight:1.5,paddingLeft:2}}>"Max risk exceeded" is applied automatically to any losing trade whose loss exceeds your risk max % (scaled by session size), so it isn't listed here.</div>
        <div style={{fontSize:11,color:"#64748b",marginTop:-4,marginBottom:8,lineHeight:1.5,paddingLeft:2}}>"Oversized entry" is applied automatically to any trade whose position size exceeds your position max (set when the trade was logged), so it isn't listed here.</div>
      </SettingsSection>

      <SettingsSection title="Economic Events" forceOpen={props.focusSection==="economicEvents"}>
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Import the week's economic calendar as JSON. Stale weeks auto-clear.</div>
        <input ref={fileInputRef} type="file" accept=".json,application/json" style={{display:"none"}} onChange={function(e){var f=e.target.files&&e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(ev){importEventsFromText(ev.target.result);};r.readAsText(f);e.target.value="";}}/>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={function(){if(fileInputRef.current)fileInputRef.current.click();}} style={{padding:"7px 14px",background:"#4f46e5",border:"none",borderRadius:5,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Upload JSON</button>
          <button onClick={function(){setShowPaste(function(o){return !o;});}} style={{padding:"7px 14px",background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{showPaste?"Cancel paste":"Paste JSON"}</button>
          <button onClick={function(){if(!confirm("Clear current events?"))return;try{localStorage.removeItem(EVENTS_KEY);}catch(e){}setEventsReloadKey(function(k){return k+1;});}} style={{padding:"7px 14px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:5,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>
        </div>
        {showPaste&&(
          <div style={{marginTop:10}}>
            <textarea ref={pasteTextRef} value={pasteText} onChange={function(e){setPasteText(e.target.value);}} placeholder="Paste JSON array of events..." style={Object.assign({},fld,{minHeight:120,fontFamily:"monospace",fontSize:12})}/>
            <button onClick={function(){importEventsFromText(pasteText);setPasteText("");setShowPaste(false);}} style={{marginTop:8,padding:"7px 14px",background:"#4f46e5",border:"none",borderRadius:5,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Import</button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Timezone">
        <Dropdown value={settings.timezone||USER_TIMEZONE} onChange={function(tz){setUserTimezone(tz);setSettings(function(s){var ns=Object.assign({},s,{timezone:tz});if(!s.sessions||s.sessions.length===0)ns.sessions=defaultSessionsForTz(tz);return ns;});}} options={TIMEZONES.map(function(tz){return {v:tz.value,l:tz.label};})}/>
      </SettingsSection>

      <SettingsSection title="Import / Export">
        <div style={{fontSize:12,color:"#64748b",marginBottom:10,lineHeight:1.5}}>Export your data as a backup file, import a previous backup, or clear all data.</div>
        <input ref={backupRef} type="file" accept=".json,application/json" style={{display:"none"}} onChange={function(e){var f=e.target.files&&e.target.files[0];if(f)restoreFromFile(f);e.target.value="";}}/>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button onClick={function(){if(backupRef.current)backupRef.current.click();}} style={{padding:"7px 14px",background:"#4f46e5",border:"none",borderRadius:5,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Import</button>
          <button onClick={backupAll} style={{padding:"7px 14px",background:"none",border:"1px solid #4338ca",borderRadius:5,color:"#a5b4fc",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Export</button>
          <button onClick={clearAll} style={{padding:"7px 14px",background:"#7f1d1d33",border:"1px solid #7f1d1d",borderRadius:5,color:"#fca5a5",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Clear Data</button>
        </div>
      </SettingsSection>

      {/* CHANGED: Fallback backup modal if download/clipboard methods fail. */}
      {backupModal&&(
        <div style={{position:"fixed",inset:0,background:"#00000099",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:20}} onClick={function(){setBackupModal(null);}}>
          <div onClick={function(e){e.stopPropagation();}} style={{background:"#111118",border:"1px solid #4338ca",borderRadius:12,padding:18,maxWidth:560,width:"100%",maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
            <div style={{fontSize:15,fontWeight:700,color:"#a5b4fc",marginBottom:6}}>Backup data</div>
            <div style={{fontSize:12,color:"#94a3b8",marginBottom:10,lineHeight:1.5}}>{backupModal.note}</div>
            <textarea readOnly value={backupModal.json} onFocus={function(e){e.target.select();}} style={Object.assign({},fld,{flex:1,minHeight:240,fontFamily:"monospace",fontSize:11,resize:"vertical"})}/>
            <div style={{display:"flex",gap:8,marginTop:10,justifyContent:"flex-end"}}>
              <button onClick={function(){
                try{
                  if(navigator.clipboard&&navigator.clipboard.writeText){
                    navigator.clipboard.writeText(backupModal.json).then(function(){alert("Copied!");},function(){});
                  }
                }catch(e){}
              }} style={{padding:"7px 14px",background:"#4f46e5",border:"none",borderRadius:5,color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Copy</button>
              <button onClick={function(){setBackupModal(null);}} style={{padding:"7px 14px",background:"none",border:"1px solid #334155",borderRadius:5,color:"#94a3b8",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Close</button>
            </div>
          </div>
        </div>
      )}
      {props.onSignOut&&(
        <SettingsSection title="AI Coach">
          {/* CHANGED: API-key field. The deployed app calls Anthropic directly from the browser,
             so it needs the user's own key. Stored in localStorage; the key is sent as
             x-api-key plus the dangerous-direct-browser-access header. */}
          {(function(){
            var [k,setK]=useState(function(){try{return localStorage.getItem("tf-anthropic-key")||"";}catch(e){return "";}});
            var [show,setShow]=useState(false);
            var [saved,setSaved]=useState(false);
            return (
              <div>
                <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.55,marginBottom:10}}>Paste your Anthropic API key to enable the AI Coach in Performance. Stored only in your browser. Get a key at <span style={{color:"#a5b4fc"}}>console.anthropic.com</span>.</div>
                <div style={{display:"flex",gap:6}}>
                  <input type={show?"text":"password"} value={k} onChange={function(e){setK(e.target.value);setSaved(false);}} placeholder="sk-ant-..." style={{flex:1,padding:"10px 12px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:8,color:"#e2e8f0",fontSize:13,fontFamily:"inherit",fontVariantNumeric:"tabular-nums"}}/>
                  <button onClick={function(){setShow(function(v){return !v;});}} style={{padding:"0 12px",background:"#0a0a0f",border:"1px solid #334155",borderRadius:8,color:"#94a3b8",fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>{show?"Hide":"Show"}</button>
                  <button onClick={function(){try{if(k.trim())localStorage.setItem("tf-anthropic-key",k.trim());else localStorage.removeItem("tf-anthropic-key");setSaved(true);setTimeout(function(){setSaved(false);},1500);}catch(e){}}} style={{padding:"0 14px",background:saved?"#166534":"#4f46e5",border:"none",borderRadius:8,color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{saved?"✓ Saved":"Save"}</button>
                </div>
              </div>
            );
          })()}
        </SettingsSection>
      )}
      {props.onSignOut&&(
        <div style={{marginTop:24,paddingTop:18,borderTop:"1px solid #1e293b",display:"flex",justifyContent:"center"}}>
          <button onClick={props.onSignOut} style={{padding:"10px 22px",background:"#1c0a0a",border:"1px solid #ef4444",borderRadius:8,color:"#fca5a5",fontSize:13,fontWeight:700,letterSpacing:0.3,cursor:"pointer",fontFamily:"inherit"}}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function ManageTradeView(props){
  var trade=props.trade,onClose=props.onClose,onSave=props.onSave,onDelete=props.onDelete,settings=props.settings,tradeOptions=props.tradeOptions;
  var [draft,setDraft]=useState(Object.assign({},trade));
  return <TradeForm trade={draft} setTrade={setDraft} onSave={function(updated){onSave(updated);}} onCancel={onClose} settings={settings} tradeOptions={tradeOptions}/>;
}

function App(props){
  props=props||{};
  // CHANGED: One-time migration — backfill discipline score on no-trade days that were saved
  // before the policy change. Walks every journal:* key in localStorage and rewrites entries
  // where noTradeDay===true && disciplineScore == null to 100. Idempotent and safe to re-run;
  // a flag (tf-ntday-disc-mig-v1) prevents the scan on subsequent loads.
  useEffect(function(){
    try{
      if(localStorage.getItem("tf-ntday-disc-mig-v1")==="1")return;
      var toRewrite=[];
      for(var i=0;i<localStorage.length;i++){
        var k=localStorage.key(i);
        if(!k||k.indexOf("journal:")!==0)continue;
        try{
          var v=localStorage.getItem(k);if(!v)continue;
          var e=JSON.parse(v);
          if(e&&e.noTradeDay===true&&(e.disciplineScore==null||e.disciplineScore===""||isNaN(parseFloat(e.disciplineScore)))){
            e.disciplineScore=100;toRewrite.push([k,JSON.stringify(e)]);
          }
        }catch(_){}
      }
      toRewrite.forEach(function(pair){try{localStorage.setItem(pair[0],pair[1]);}catch(_){}});
      localStorage.setItem("tf-ntday-disc-mig-v1","1");
      if(toRewrite.length>0&&typeof bumpReloadKey==="function")try{bumpReloadKey();}catch(_){}
    }catch(e){console.error("No-trade-day discipline backfill failed:",e);}
  },[]);
  // CHANGED: When the parent (auth/sync wrapper) signals a completed cloud pull via syncTick,
  // refresh data from localStorage WITHOUT remounting — this preserves all in-progress UI state
  // (forms, drafts, editing, scroll position). Without this the app was remounting on every
  // tab return and erasing whatever the user had been typing.
  useEffect(function(){
    // Don't fire on initial mount (syncTick=0); only on subsequent increments.
    if(props.syncTick==null||props.syncTick===0)return;
    try{bumpReloadKey();}catch(e){}
  },[props.syncTick]);
  // CHANGED: Persist active tab in sessionStorage so it survives reloads but isn't wiped by cloud-sync (which rewrites localStorage).
  // CHANGED: Always open to the home (dashboard) tab on sign-in / app load. Previously the
  // last-active tab was restored from sessionStorage which could land you in Settings or
  // Performance after a refresh — surprising and rarely what you want first.
  var [tab,setTab]=useState("dashboard");
  useEffect(function(){try{sessionStorage.setItem("tf-active-tab",tab);}catch(e){}},[tab]);
  // CHANGED: Collapsible sidebar state for laptop layout.
  var [sidebarCollapsed,setSidebarCollapsed]=useState(true);
  var [pendingWithdrawAmount,setPendingWithdrawAmount]=useState(null);
  // CHANGED: lets a deep-link (e.g. Economic Events "Go to Settings") auto-expand a settings section.
  var [settingsFocus,setSettingsFocus]=useState(null);
  var [state,setState]=useState(function(){
    try{
      var stored=localStorage.getItem(STORAGE_KEY);
      if(stored){
        var p=JSON.parse(stored);
        if(p&&p.date===todayStr()){p.trades=migrateTrades(p.trades||[]);return p;}
      }
    }catch(e){}
    // CHANGED: After a restore/import or a fresh sign-in, state.trades for today may be empty even
    // though journal:today has trades. Hydrate from the journal entry so the "Today" view doesn't
    // show "No trades logged yet" while the SAVED TO JOURNAL stats show trades present.
    try{
      var key="journal:"+todayStr().replace(/\//g,"-");
      var je=localStorage.getItem(key);
      if(je){
        var jp=JSON.parse(je);
        if(jp&&Array.isArray(jp.trades)&&jp.trades.length>0){
          var fresh=defaultState();
          fresh.date=todayStr();
          fresh.trades=migrateTrades(jp.trades);
          if(jp.commitment)fresh.commitment=jp.commitment;
          if(jp.ruleViolations)fresh.ruleViolations=jp.ruleViolations;
          if(jp.note)fresh.dailyNote=jp.note;
          return fresh;
        }
      }
    }catch(e){}
    return defaultState();
  });
  var [settings,setSettings]=useState(function(){
    try{var s=localStorage.getItem(SETTINGS_KEY);if(s){var p=JSON.parse(s);return Object.assign({},defaultSettings(),p);}}catch(e){}
    return defaultSettings();
  });
  var [tradeOptions,setTradeOptions]=useState(loadOptions());
  // CHANGED: Persist in-progress new-trade form so a sync-triggered remount doesn't lose what the user typed.
  // Survives the remount via sessionStorage (cloud sync only touches localStorage).
  var [showForm,setShowForm]=useState(function(){try{return sessionStorage.getItem("tf-trade-draft-open")==="1";}catch(e){return false;}});
  var [trade,setTrade]=useState(function(){try{var raw=sessionStorage.getItem("tf-trade-draft");if(raw){var t=JSON.parse(raw);if(t&&typeof t==="object")return t;}}catch(e){}return null;});
  useEffect(function(){
    try{
      if(showForm&&trade){
        sessionStorage.setItem("tf-trade-draft-open","1");
        sessionStorage.setItem("tf-trade-draft",JSON.stringify(trade));
      }else{
        sessionStorage.removeItem("tf-trade-draft-open");
        sessionStorage.removeItem("tf-trade-draft");
      }
    }catch(e){}
  },[showForm,trade]);
  var [reloadKey,setReloadKey]=useState(0);
  var [eventsReloadKey,setEventsReloadKey]=useState(0);
  // CHANGED: Persist event filters across page refreshes via EVENT_FILTERS_KEY.
  var [eventCurrencyFilter,setEventCurrencyFilter]=useState(function(){try{var s=localStorage.getItem(EVENT_FILTERS_KEY);if(s){var p=JSON.parse(s);if(p&&Array.isArray(p.currency))return p.currency;}}catch(e){}return [];});
  var [eventImpactFilter,setEventImpactFilter]=useState(function(){try{var s=localStorage.getItem(EVENT_FILTERS_KEY);if(s){var p=JSON.parse(s);if(p&&Array.isArray(p.impact))return p.impact;}}catch(e){}return [];});
  useEffect(function(){try{localStorage.setItem(EVENT_FILTERS_KEY,JSON.stringify({currency:eventCurrencyFilter,impact:eventImpactFilter}));}catch(e){}},[eventCurrencyFilter,eventImpactFilter]);
  var [tradesInitialDate,setTradesInitialDate]=useState(null);
  var [liveTradeManaging,setLiveTradeManaging]=useState(null);
  var [checklistVersion,setChecklistVersion]=useState(0);
  // Update CACHED_SESSIONS for getSessionAt to use.
  useEffect(function(){CACHED_SESSIONS=getSessions(settings);},[settings]);
  // CHANGED: Auto-save today's journal entry whenever closed trades, daily note, commitment, or
  // riskMax changes. Debounced 500ms to avoid hammering localStorage on every keystroke. Preserves
  // wasLocked / lockScore / lockedAt fields written by the lock side-effect.
  useEffect(function(){
    var timer=setTimeout(function(){
      try{
        var closedT=(state.trades||[]).filter(function(t){return t&&t.status!=="open";});
        var note=state.dailyNote||"";
        // No closed trades AND no note → don't create an empty journal entry.
        if(closedT.length===0&&!note)return;
        var key="journal:"+todayStr().replace(/\//g,"-");
        var existing=null;try{var raw=localStorage.getItem(key);if(raw)existing=JSON.parse(raw);}catch(e){}
        var riskMaxN=parseFloat(settings.riskMax)||0;
        var discScore=0;try{discScore=calcDiscipline(closedT,riskMaxN,{commitment:state.commitment||null});}catch(e){}
        var entry={
          date:todayStr(),
          pnl:closedT.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0),
          trades:closedT,
          note:note,
          ruleViolations:state.ruleViolations||[],
          commitment:state.commitment||null,
          wins:closedT.filter(function(t){return parseFloat(t.pnl)>0;}).length,
          losses:closedT.filter(function(t){return parseFloat(t.pnl)<0;}).length,
          riskMax:riskMaxN,
          disciplineScore:discScore,
          // CHANGED: Snapshot today's filtered economic events into the journal entry so the day
          // is self-contained — viewing it later shows what events were relevant when traded,
          // even if the event cache or user's filters change.
          events:(function(){try{return getTodaysFilteredEvents().map(eventToStorable).filter(Boolean);}catch(e){return [];}})()
        };
        // Preserve lock-side fields if they exist on the saved entry.
        if(existing){
          // CHANGED: But CLEAR them if the recomputed score is now above threshold — keeps the
          // calendar "D" marker and the half-size cooldown in sync with current truth.
          var thr=loadDisciplineLockThreshold();
          var keepLock=existing.wasLocked&&discScore<thr;
          if(keepLock){
            if(existing.wasLocked)entry.wasLocked=existing.wasLocked;
            if(existing.lockScore!=null)entry.lockScore=existing.lockScore;
            if(existing.lockThreshold!=null)entry.lockThreshold=existing.lockThreshold;
            if(existing.lockedAt!=null)entry.lockedAt=existing.lockedAt;
          }
          if(existing.noTradeDay)entry.noTradeDay=existing.noTradeDay;
          if(existing.noTradeShots)entry.noTradeShots=existing.noTradeShots;
        }
        safeWriteJournalEntry(key,entry);
        // CHANGED: nudge dependent components (TradesTab "Saved to Journal" panel, calendar,
        // Performance, etc.) to re-read from localStorage now that the entry is fresh.
        try{bumpReloadKey();}catch(e){}
      }catch(e){}
    },500);
    return function(){clearTimeout(timer);};
  // eslint-disable-next-line
  },[state.trades,state.dailyNote,state.commitment,state.ruleViolations,settings.riskMax]);
  // CHANGED: One-time migration — re-evaluate "Oversized entry" against the session-scaled posMax,
  // and restamp posMaxAtEntry on all historical trades. Skips silently on storage quota errors.
  useEffect(function(){
    try{
      if(localStorage.getItem("tf-oversize-migrated-v4"))return;
      var rawMax=parseFloat(settings.positionMax)||0;
      if(rawMax<=0)return;
      var sessions=getSessions(settings);
      function sfFor(t){
        if(t.sizeFraction!=null&&!isNaN(parseFloat(t.sizeFraction)))return parseFloat(t.sizeFraction);
        if(t.sessionId){var s=sessions.find(function(x){return x.id===t.sessionId;});if(s&&s.sizeFraction!=null)return parseFloat(s.sizeFraction)||1;}
        return 1;
      }
      function fixTrade(t){
        if(!t)return {t:t,changed:false};
        // CHANGED: Re-derive sessionId from start time so trades added off-hours get matched to their proper session.
        var derivedSession=getSessionForTrade(t);
        var sessionId=derivedSession||t.sessionId||null;
        var working=sessionId===t.sessionId?t:Object.assign({},t,{sessionId:sessionId});
        var sf=sfFor(working);
        var eff=rawMax*sf;
        var pos=parseFloat(working.positionSize)||0;
        var v=(working.violations||[]).slice();
        var hasV=v.indexOf("Oversized entry")>=0;
        var shouldHaveV=eff>0&&pos>eff;
        var changed=working!==t;
        if(shouldHaveV&&!hasV){v.push("Oversized entry");changed=true;}
        if(!shouldHaveV&&hasV){v=v.filter(function(x){return x!=="Oversized entry";});changed=true;}
        if((working.posMaxAtEntry||0)!==eff){changed=true;}
        if(!changed)return {t:t,changed:false};
        return {t:Object.assign({},working,{violations:v,posMaxAtEntry:eff}),changed:true};
      }
      // 1) Journal entries.
      var keys=[];
      for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf("journal:")===0)keys.push(k);}
      keys.forEach(function(k){
        try{
          var raw=localStorage.getItem(k);if(!raw)return;
          var entry=JSON.parse(raw);if(!entry||!entry.trades)return;
          var tradesChanged=false;
          var nt=entry.trades.map(function(tr){var r=fixTrade(tr);if(r.changed)tradesChanged=true;return r.t;});
          // CHANGED: Always recompute disciplineScore — even when trades didn't change this run, the
          // stored score may be stale from a prior migration version that didn't recompute discipline.
          var newScore=entry.disciplineScore;
          try{
            var closedT=nt.filter(function(x){return x&&x.status!=="open";});
            var riskMaxN=parseFloat(entry.riskMax)||0;
            newScore=calcDiscipline(closedT,riskMaxN,{commitment:entry.commitment||null});
          }catch(de){}
          var scoreChanged=(parseFloat(entry.disciplineScore)||0)!==(parseFloat(newScore)||0);
          if(tradesChanged||scoreChanged){
            entry.trades=nt;
            entry.disciplineScore=newScore;
            try{localStorage.setItem(k,JSON.stringify(entry));}catch(qe){/* quota or other — skip */}
          }
        }catch(e){}
      });
      // 2) Live state.trades.
      if(state.trades&&state.trades.length){
        var liveChanged=false;
        var newLive=state.trades.map(function(tr){var r=fixTrade(tr);if(r.changed)liveChanged=true;return r.t;});
        if(liveChanged)setState(function(prev){return Object.assign({},prev,{trades:newLive});});
      }
      try{localStorage.setItem("tf-oversize-migrated-v4","1");}catch(e){}
      bumpReloadKey();
    }catch(e){}
  // eslint-disable-next-line
  },[]);
  // Persist hide-dollar setting globally.
  useEffect(function(){setHideDollarPnL(!!settings.hideDollarPnL);},[settings.hideDollarPnL]);
  // CHANGED: Recalc derived position/risk from canonical account balance helper.
  useEffect(function(){
    var live=(state.trades||[]).filter(function(t){return t.status!=="open";}).reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
    var computedAcct=computeAccountBalance(live);
    var p={sizingMode:settings.sizingMode,slippagePct:settings.slippagePct,positionMaxPct:settings.positionMaxPct,riskMaxPct:settings.riskMaxPct,positionMaxDollar:settings.positionMaxDollar,riskMaxDollar:settings.riskMaxDollar};
    var sizes=calcPosSizes(computedAcct,p);
    if(sizes.positionMin!==settings.positionMin||sizes.positionMax!==settings.positionMax||sizes.riskMin!==settings.riskMin||sizes.riskMax!==settings.riskMax){
      setSettings(function(s){return Object.assign({},s,{positionMin:sizes.positionMin,positionMax:sizes.positionMax,riskMin:sizes.riskMin,riskMax:sizes.riskMax});});
    }
  },[settings.sizingMode,settings.slippagePct,settings.positionMaxPct,settings.riskMaxPct,settings.positionMaxDollar,settings.riskMaxDollar,state.trades,reloadKey]);
  useEffect(function(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch(e){}},[state]);
  useEffect(function(){try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));}catch(e){}},[settings]);
  // Daily rollover - if date has changed, save journal entry and reset state
  useEffect(function(){
    function checkRollover(){
      var today=todayStr();
      if(state.date&&state.date!==today){
        // CHANGED: Never blindly overwrite an existing journal entry. Read the current entry for
        // yesterday and merge: if it already has trades, keep them; if both have trades, union by id.
        // This prevents catastrophic loss when state.trades is stale/partial relative to the saved
        // journal (e.g., after cloud-pull, migration, or app reopened past midnight).
        if(state.trades&&state.trades.length>0){
          var key="journal:"+state.date.replace(/\//g,"-");
          var existing=null;
          try{var raw=localStorage.getItem(key);if(raw)existing=JSON.parse(raw);}catch(e){}
          var mergedTrades=state.trades.slice();
          if(existing&&Array.isArray(existing.trades)&&existing.trades.length>0){
            var seen={};
            mergedTrades.forEach(function(t){if(t&&t.id!=null)seen[t.id]=true;});
            existing.trades.forEach(function(t){if(t&&t.id!=null&&!seen[t.id])mergedTrades.push(t);});
          }
          var pnl=mergedTrades.reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
          var wins=mergedTrades.filter(function(t){return parseFloat(t.pnl)>0;}).length;
          var losses=mergedTrades.filter(function(t){return parseFloat(t.pnl)<0;}).length;
          var rolloverRiskMax=parseFloat(settings.riskMax)||(existing&&existing.riskMax)||0;
          var entry=Object.assign({},existing||{},{
            date:state.date,
            pnl:pnl,
            trades:mergedTrades,
            wins:wins,
            losses:losses,
            disciplineScore:calcDiscipline(mergedTrades,rolloverRiskMax,{commitment:state.commitment||(existing&&existing.commitment)||null}),
            note:state.dailyNote||(existing&&existing.note)||"",
            riskMax:rolloverRiskMax,
            commitment:state.commitment||(existing&&existing.commitment)||null
          });
          safeWriteJournalEntry(key,entry);
        }
        setState(defaultState());
      }
    }
    checkRollover();
    var id=setInterval(checkRollover,60000);
    return function(){clearInterval(id);};
  },[state.date]);
  var [phase,setPhase]=useState(getPhase());
  // CHANGED: Re-check phase every second so the trade button enables promptly when a session opens (was 30s, caused noticeable lag).
  useEffect(function(){var id=setInterval(function(){setPhase(function(prev){var next=getPhase();return next!==prev?next:prev;});},1000);return function(){clearInterval(id);};},[]);
  function autoAddViolations(t,posMax){
    var v=(t.violations||[]).slice();
    var pos=parseFloat(t.positionSize)||0;
    var pnlNum=parseFloat(t.pnl);
    var pctNum=parseFloat(t.pctPnl);
    var riskMaxPct=(settings&&settings.riskMaxPct!=null)?parseFloat(settings.riskMaxPct):33;
    // Session size fraction — always recompute from the trade's session (don't trust a previously
    // stamped sizeFraction, which may be a legacy compounded value baked in by older code).
    var sf=1;
    if(t.sessionId){try{var sess=getSessions(settings).find(function(s){return s.id===t.sessionId;});if(sess&&sess.sizeFraction!=null)sf=parseFloat(sess.sizeFraction)||1;}catch(e){}}
    // CHANGED: Half-size lock means "at most half of full size", not "half of whatever the
    // session already shrank you to". Without this floor, a session with sf=0.5 combined with the
    // lock's ×0.5 produced 0.25 — way more restrictive than the user expects from "half-size".
    try{var lk=checkDisciplineLock(state.trades,state.commitment);if(lk&&lk.locked)sf=Math.min(sf,0.5);}catch(e){}
    var effPosMax=posMax>0?posMax*sf:0;
    // CHANGED: Auto-violations must be REMOVABLE — if a re-save brings the trade within the cap,
    // the previous "Oversized entry" flag should clear. Same for "Max risk exceeded".
    var overIdx=v.indexOf("Oversized entry");
    if(effPosMax>0&&pos>effPosMax){
      if(overIdx<0)v.push("Oversized entry");
    }else if(overIdx>=0){
      v.splice(overIdx,1);
    }
    var stopThreshPct=(riskMaxPct>0)?riskMaxPct*sf:0;
    var maxRiskIdx=v.indexOf("Max risk exceeded");
    var stoppedOut=(!isNaN(pnlNum)&&pnlNum<0&&!isNaN(pctNum)&&stopThreshPct>0&&pctNum<-stopThreshPct);
    if(stoppedOut){
      if(maxRiskIdx<0)v.push("Max risk exceeded");
    }else if(maxRiskIdx>=0){
      v.splice(maxRiskIdx,1);
    }
    var patch={violations:v,sizeFraction:sf};
    if(effPosMax>0)patch.posMaxAtEntry=effPosMax;
    if(stopThreshPct>0)patch.stopThreshPctAtEntry=stopThreshPct;
    return Object.assign({},t,patch);
  }
  function saveTrade(t){
    var entries=t.entries||[],exits=t.exits||[];
    var totalEntryC=entries.reduce(function(s,e){return s+(parseFloat(e.contracts)||0);},0);
    var totalExitC=exits.reduce(function(s,e){return s+(parseFloat(e.contracts)||0);},0);
    var status="closed";
    if(totalEntryC>0&&totalExitC<totalEntryC)status="open";
    // CHANGED: Tag the trade with the current session phase so per-session trade limits work.
    // CHANGED: Derive sessionId from the trade's actual start time instead of relying on the current phase.
    // This way trades added after-hours, or with backdated entry times, get assigned to the correct session window.
    var sessionId=getSessionForTrade(t);
    if(sessionId==null)sessionId=t.sessionId||(phase!=="closed"?phase:null);
    // CHANGED: Derive trade length from leg times.
    //   openedAt = time of first entry leg (the moment the position was first opened).
    //   closedAt = time of last exit leg (when the trade fully closed).
    // Falls back to existing openedAt/Date.now() for trades without leg timestamps (legacy data).
    var entryTimes=entries.map(function(e){return e.time;}).filter(function(x){return !!x;});
    var exitTimes=exits.map(function(e){return e.time;}).filter(function(x){return !!x;});
    var derivedOpenedAt=entryTimes.length>0?Math.min.apply(null,entryTimes):(t.openedAt||Date.now());
    var derivedClosedAt=null;
    if(status==="closed"){
      derivedClosedAt=exitTimes.length>0?Math.max.apply(null,exitTimes):(t.closedAt||Date.now());
    }
    var enriched=autoAddViolations(Object.assign({},t,{openedAt:derivedOpenedAt,closedAt:derivedClosedAt,status:status,sessionId:sessionId}),settings.positionMax);
    // CHANGED: Compute updated trades list outside setState so we can sync the journal too.
    var existingIdx=state.trades.findIndex(function(x){return x.id===enriched.id;});
    var ut=existingIdx>=0?state.trades.map(function(x){return x.id===enriched.id?enriched:x;}):state.trades.concat([enriched]);
    setState(function(s){return Object.assign({},s,{trades:ut});});
    // CHANGED: If today's journal entry exists, also update it so the saved P&L reflects the new/edited trade.
    var journalWasUpdated=false;
    try{
      var key="journal:"+todayStr().replace(/\//g,"-");
      var existingJournal=localStorage.getItem(key);
      if(existingJournal){
        var entry=JSON.parse(existingJournal);
        var closedTrades=ut.filter(function(x){return x.status!=="open";});
        var updated=Object.assign({},entry,{
          trades:closedTrades,
          wins:closedTrades.filter(function(x){return parseFloat(x.pnl)>0;}).length,
          losses:closedTrades.filter(function(x){return parseFloat(x.pnl)<0;}).length,
          pnl:closedTrades.reduce(function(sum,x){return sum+(parseFloat(x.pnl)||0);},0),
          disciplineScore:calcDiscipline(closedTrades,(entry.riskMax!=null&&parseFloat(entry.riskMax)>0)?parseFloat(entry.riskMax):(parseFloat(settings.riskMax)||0),{commitment:entry.commitment||null}),
          // CHANGED: Snapshot the day's filtered economic events into the journal entry. For
          // edits to today, refreshes the snapshot. For past-day edits, keeps the existing snapshot.
          events:(entry.events&&entry.events.length>0)?entry.events:(function(){try{var d=(function(s){if(!s)return null;var m=String(s).match(/^(\d+)[\/\-](\d+)[\/\-](\d+)\$/);if(!m)return null;return new Date(parseInt(m[3],10),parseInt(m[1],10)-1,parseInt(m[2],10));})(entry.date)||(dateKey===todayStr()?getPT():null);return getFilteredEventsForDate(d).map(eventToStorable).filter(Boolean);}catch(e){return [];}})()
        });
        // CHANGED: If this entry was originally a No-Trade Day but trades have now been logged,
        // convert it to a regular day — but preserve the original sit-out reasons as historical
        // record (initialNoTradeReasons/Reason). Valuable journaling data: "I planned to sit out
        // because X, then took a trade when conditions changed."
        if(entry.noTradeDay&&closedTrades.length>0){
          updated.noTradeDay=false;
          if((entry.noTradeReasons||[]).length>0&&!entry.initialNoTradeReasons)updated.initialNoTradeReasons=entry.noTradeReasons.slice();
          if(entry.noTradeReason&&!entry.initialNoTradeReason)updated.initialNoTradeReason=entry.noTradeReason;
          if(entry.noTradeLoggedAt&&!entry.initialNoTradeLoggedAt)updated.initialNoTradeLoggedAt=entry.noTradeLoggedAt;
        }
        // CHANGED: If editing brought today's discipline back above threshold, clear the lock-trigger
        // metadata so the calendar "D" marker disappears and the half-size cooldown lifts. The lock
        // is no longer immutable — it reflects current truth, not historical intent.
        var newScore=updated.disciplineScore;
        var lockThreshold=loadDisciplineLockThreshold();
        if(entry.wasLocked&&newScore!=null&&parseFloat(newScore)>=lockThreshold){
          updated.wasLocked=false;
          delete updated.lockScore;
          delete updated.lockThreshold;
          delete updated.lockedAt;
        }
        localStorage.setItem(key,JSON.stringify(updated));
        journalWasUpdated=true;
      }
    }catch(e){}
    // Always bump reload key so all tabs refresh derived data.
    bumpReloadKey();
    setShowForm(false);
    setTrade(null);
    setLiveTradeManaging(null);
  }
  function deleteTrade(id){
    var ut=state.trades.filter(function(t){return t.id!==id;});
    setState(function(s){return Object.assign({},s,{trades:ut});});
    // CHANGED: Keep today's journal entry in sync after deletion.
    try{
      var key="journal:"+todayStr().replace(/\//g,"-");
      var existingJournal=localStorage.getItem(key);
      if(existingJournal){
        var entry=JSON.parse(existingJournal);
        var closedTrades=ut.filter(function(x){return x.status!=="open";});
        var updated=Object.assign({},entry,{
          trades:closedTrades,
          wins:closedTrades.filter(function(x){return parseFloat(x.pnl)>0;}).length,
          losses:closedTrades.filter(function(x){return parseFloat(x.pnl)<0;}).length,
          pnl:closedTrades.reduce(function(sum,x){return sum+(parseFloat(x.pnl)||0);},0),
          disciplineScore:calcDiscipline(closedTrades,(entry.riskMax!=null&&parseFloat(entry.riskMax)>0)?parseFloat(entry.riskMax):(parseFloat(settings.riskMax)||0),{commitment:entry.commitment||null}),
          // CHANGED: Snapshot the day's filtered economic events into the journal entry. For
          // edits to today, refreshes the snapshot. For past-day edits, keeps the existing snapshot.
          events:(entry.events&&entry.events.length>0)?entry.events:(function(){try{var d=(function(s){if(!s)return null;var m=String(s).match(/^(\d+)[\/\-](\d+)[\/\-](\d+)\$/);if(!m)return null;return new Date(parseInt(m[3],10),parseInt(m[1],10)-1,parseInt(m[2],10));})(entry.date)||(dateKey===todayStr()?getPT():null);return getFilteredEventsForDate(d).map(eventToStorable).filter(Boolean);}catch(e){return [];}})()
        });
        localStorage.setItem(key,JSON.stringify(updated));
      }
    }catch(e){}
    bumpReloadKey();
  }
  function bumpReloadKey(){setReloadKey(function(k){return k+1;});}
  var preCheckComplete=isPreCheckComplete(state.preChecklist);
  var totalPnL=state.trades.filter(function(t){return t.status!=="open";}).reduce(function(s,t){return s+(parseFloat(t.pnl)||0);},0);
  var liveTrades=state.trades.filter(function(t){return t.status==="open";});
  // CHANGED: Compute effective size-fraction (session sizeFraction × 0.5 when discipline-locked)
  // up here so both tradeStatus and the display values below share the same scaling.
  var sessForSf=getSessions(settings).find(function(s){return s.id===phase;});
  var effSF=sessForSf&&sessForSf.sizeFraction!=null?parseFloat(sessForSf.sizeFraction)||1:1;
  var liveLockForSF=checkDisciplineLock(state.trades,state.commitment);
  if(liveLockForSF.locked)effSF=Math.min(effSF,0.5);
  var tradeStatus=(function(){
    // CHANGED: Market-closed no longer blocks new trades — users may log fills from extended hours
    // or trades placed elsewhere right after the bell. All other gates (pre-market checklist,
    // conditions, session disabled, day-of-week, max trades, daily R stops) still apply.
    if(!preCheckComplete)return {ok:false,reason:"Complete pre-market checklist first"};
    // CHANGED: Conditions check removed — feature deprecated.
    var rule=getSessions(settings).find(function(s){return s.id===phase;});
    if(rule&&rule.enabled===false)return {ok:false,reason:"Session disabled"};
    var dayOfWeek=getNow().getDay();
    if(rule&&rule.days&&rule.days.indexOf(dayOfWeek)<0)return {ok:false,reason:"Session not active today"};
    // CHANGED: Enforce per-session maxTrades limit. Counts trades whose sessionId matches the current phase.
    if(rule&&rule.maxTrades!=null&&rule.maxTrades>=0){
      var sessionTrades=(state.trades||[]).filter(function(t){return t.sessionId===phase;}).length;
      if(sessionTrades>=rule.maxTrades)return {ok:false,reason:"Max "+rule.maxTrades+" trade"+(rule.maxTrades===1?"":"s")+" reached for this session"};
    }
    // CHANGED: Daily R stops now use the session-/lock-scaled riskMax so a half-size day hits
    // its hard stops at half the dollar movement (1R loss = half the dollars).
    if(rule){
      var riskMaxNum=(parseFloat(settings.riskMax)||0)*effSF;
      if(riskMaxNum>0){
        var rStops=getSessionRStops(rule);
        var dayR=totalPnL/riskMaxNum;
        if(dayR<=rStops.lossR)return {ok:false,reason:"Daily loss stop hit ("+rStops.lossR.toFixed(1)+"R)"+(liveLockForSF.locked?" — half-size":"")};
        if(dayR>=rStops.gainR)return {ok:false,reason:"Daily gain stop hit (+"+rStops.gainR.toFixed(1)+"R)"+(liveLockForSF.locked?" — half-size":"")};
      }
    }
    return {ok:true};
  })();
  var prevDate=null,prevPnL=null,prevRiskMax=null;
  (function(){var rows=loadJournalRows().filter(function(r){return r.date!==todayStr();});rows.sort(function(a,b){return new Date(b.date)-new Date(a.date);});if(rows.length>0){prevDate=rows[0].date;prevPnL=rows[0].pnl;prevRiskMax=rows[0].riskMax!=null?parseFloat(rows[0].riskMax):null;}})();
  function navigateToTrade(date){setTradesInitialDate(date);setTab("trades");}
  // CHANGED: Live clock that updates every second for the header.
  var [headerNow,setHeaderNow]=useState(getNow());
  useEffect(function(){var id=setInterval(function(){setHeaderNow(getNow());},1000);return function(){clearInterval(id);};},[]);
  function fmtClock(d){var h=d.getHours(),m=d.getMinutes(),s=d.getSeconds();return (h%12||12)+":"+(m<10?"0"+m:m)+":"+(s<10?"0"+s:s)+" "+(h>=12?"PM":"AM");}
  // R progress bar metrics
  var riskMaxNum=parseFloat(settings.riskMax)||0;
  var gainMult=parseFloat(settings.gainMultiplier)||5;
  var rValue=riskMaxNum>0?totalPnL/riskMaxNum:0;
  // Range: -1R (max loss limit) to +gainMult R (e.g. +5R target). Pad to nice numbers.
  var rMinScale=-1;
  var rMaxScale=gainMult;
  var rDisplay=Math.max(rMinScale,Math.min(rMaxScale,rValue));
  var rPct=((rDisplay-rMinScale)/(rMaxScale-rMinScale))*100;
  var rZeroPct=((0-rMinScale)/(rMaxScale-rMinScale))*100;
  var rColor=rValue>=0?"#22c55e":"#ef4444";
  var rTextColor=rValue>=0?"#86efac":"#fca5a5";
  // CHANGED: Inject viewport meta + track window width so mobile auto-activates on narrow screens (iPhone).
  var [winW,setWinW]=useState(typeof window!=="undefined"?window.innerWidth:1024);
  useEffect(function(){
    try{
      var m=document.querySelector('meta[name="viewport"]');
      if(!m){m=document.createElement("meta");m.name="viewport";document.head.appendChild(m);}
      m.content="width=device-width,initial-scale=1,viewport-fit=cover";
    }catch(e){}
    function r(){setWinW(window.innerWidth);}
    window.addEventListener("resize",r);
    window.addEventListener("orientationchange",r);
    return function(){window.removeEventListener("resize",r);window.removeEventListener("orientationchange",r);};
  },[]);
  // CHANGED: view-mode — explicit user choice wins; otherwise auto-detect from viewport width (<768px = mobile).
  // CHANGED: Auto-detect only. Toggle removed; viewport width decides layout. 640px = phone-landscape cutoff so laptop windows don't trigger mobile.
  var mobile=winW<640;
  return (
    <div style={{minHeight:"100vh",background:"#0a0a0f",color:"#e2e8f0",fontFamily:"-apple-system,BlinkMacSystemFont,system-ui,sans-serif",display:"flex"}}>
      {/* CHANGED: Collapsible laptop left sidebar navigation — hidden in mobile view. */}
      {!mobile&&<div style={{width:sidebarCollapsed?64:220,flexShrink:0,background:"#111118",borderRight:"1px solid #1e293b",height:"100vh",position:"sticky",top:0,display:"flex",flexDirection:"column",padding:sidebarCollapsed?"22px 8px":"22px 14px",boxSizing:"border-box",transition:"width 0.18s ease"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:sidebarCollapsed?"center":"space-between",marginBottom:18,minHeight:24,gap:8}}>
          {!sidebarCollapsed&&<div style={{padding:"0 4px"}}><div style={{fontSize:17,fontWeight:800,color:"#e2e8f0",letterSpacing:-0.5,lineHeight:1.1}}>Psycho</div><div style={{fontSize:17,fontWeight:800,color:"#a5b4fc",letterSpacing:-0.5,lineHeight:1.1}}>Trader</div></div>}
          <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
            {!sidebarCollapsed&&<button onClick={function(){setSettings(function(s){return Object.assign({},s,{hideDollarPnL:!s.hideDollarPnL});});}} aria-label={settings.hideDollarPnL?"Show $ amounts":"Hide $ amounts"} title={settings.hideDollarPnL?"Showing %. Tap to show $.":"Showing $. Tap to hide."} style={{width:32,height:32,flexShrink:0,background:settings.hideDollarPnL?"#1e1b4b":"#0a0a0f",border:"1px solid "+(settings.hideDollarPnL?"#4338ca":"#334155"),borderRadius:8,color:settings.hideDollarPnL?"#a5b4fc":"#94a3b8",fontSize:16,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center"}}>{settings.hideDollarPnL?"%":"$"}</button>}
            <button onClick={function(){setSidebarCollapsed(function(c){return !c;});}} aria-label={sidebarCollapsed?"Expand sidebar":"Collapse sidebar"} title={sidebarCollapsed?"Expand":"Collapse"} style={{width:32,height:32,flexShrink:0,background:"#0a0a0f",border:"1px solid #334155",borderRadius:8,color:"#94a3b8",fontSize:16,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center"}}>{sidebarCollapsed?"»":"«"}</button>
          </div>
        </div>
        {[{id:"dashboard",label:"Home",icon:"⌂"},{id:"trades",label:"Journal",icon:"≡"},{id:"goals",label:"Goals",icon:"◎"},{id:"performance",label:"Performance",icon:"📈"},{id:"settings",label:"Settings",icon:"⚙"}].map(function(t){
          var active=tab===t.id;
          return <button key={t.id} onClick={function(){if(t.id!=="trades")setTradesInitialDate(null);setPendingWithdrawAmount(null);setSettingsFocus(null);setTab(t.id);setSidebarCollapsed(true);}} title={sidebarCollapsed?t.label:""} style={{textAlign:"left",padding:sidebarCollapsed?"11px 0":"11px 12px",marginBottom:4,background:active?"#1e1b4b":"none",border:"none",borderRadius:8,color:active?"#a5b4fc":"#94a3b8",fontSize:14,fontWeight:active?700:500,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:sidebarCollapsed?"center":"flex-start",gap:10}}>
            <span style={{fontSize:16,width:20,textAlign:"center",flexShrink:0}}>{t.icon}</span>
            {!sidebarCollapsed&&t.label}
          </button>;
        })}
      </div>}
      <div style={{flex:1,minWidth:0}}>
      <div style={{maxWidth:mobile?560:"min(1800px, 96vw)",margin:"0 auto",padding:mobile?"0 12px 84px":"0 28px 60px"}}>
        <div style={{padding:"16px 0 12px",position:"sticky",top:0,background:"#0a0a0f",zIndex:50,borderBottom:"1px solid #1e293b"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,gap:12}}>
            <div style={{flex:1,minWidth:0}}>
              {/* CHANGED: brand only shows in mobile (no sidebar there); laptop shows date/session prominently. */}
              {mobile&&(
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                  <div style={{fontSize:13,fontWeight:800,color:"#a5b4fc",letterSpacing:-0.2}}>Psycho Trader</div>
                  {/* CHANGED: Hide-$ toggle — on laptop it lives in the sidebar (hidden on mobile),
                     so surface it here next to the brand. Same toggle action, same styling cues. */}
                  <button onClick={function(){setSettings(function(s){return Object.assign({},s,{hideDollarPnL:!s.hideDollarPnL});});}} aria-label={settings.hideDollarPnL?"Show $ amounts":"Hide $ amounts"} style={{width:24,height:24,flexShrink:0,background:settings.hideDollarPnL?"#1e1b4b":"#0a0a0f",border:"1px solid "+(settings.hideDollarPnL?"#4338ca":"#334155"),borderRadius:6,color:settings.hideDollarPnL?"#a5b4fc":"#94a3b8",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",padding:0,lineHeight:1}}>{settings.hideDollarPnL?"%":"$"}</button>
                </div>
              )}
              <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",letterSpacing:-0.3}}>{todayDisplay()}</div>
              <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",marginTop:2,fontVariantNumeric:"tabular-nums"}}>{fmtClock(headerNow)}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:11,color:"#64748b",letterSpacing:1,textTransform:"uppercase"}}>{(TIMEZONES.find(function(z){return z.value===(settings.timezone||USER_TIMEZONE);})||{label:""}).label.replace(/.*\((.+)\).*/,"$1")||""}</div>
                <div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",marginTop:2,letterSpacing:-0.3}}>{getPhaseLabel(phase)}</div>
              </div>
            </div>
          </div>
        </div>
        {(function(){
          // CHANGED: Reuse effSF computed above (session sizeFraction × discipline-lock half) so display + hard-stops agree.
          var sf=effSF;
          var dPosMin=Math.round((settings.positionMin||0)*sf);
          var dPosMax=Math.round((settings.positionMax||0)*sf);
          var dRiskMin=Math.round((settings.riskMin||0)*sf);
          var dRiskMax=Math.round((settings.riskMax||0)*sf);
          return (<>
            {tab==="dashboard"&&<DashboardTab key={reloadKey} mobile={mobile} settings={settings} phase={phase} state={state} setState={setState} checklistVersion={checklistVersion} onNavigateToJournal={function(){setTab("trades");}} onStartTrade={function(){var t=mkTrade();t.sessionId=phase!=="closed"?phase:null;setTrade(t);setShowForm(true);setTab("trades");}} preCheckComplete={preCheckComplete} currentAccount={computeAccountBalance(totalPnL)} displayPosMin={dPosMin} displayPosMax={dPosMax} displayRiskMin={dRiskMin} displayRiskMax={dRiskMax} totalPnL={totalPnL} todayTrades={state.trades} prevPnL={prevPnL} prevDate={prevDate} prevRiskMax={prevRiskMax} onNavigateToTrade={navigateToTrade} eventsReloadKey={eventsReloadKey} eventCurrencyFilter={eventCurrencyFilter} setEventCurrencyFilter={setEventCurrencyFilter} eventImpactFilter={eventImpactFilter} setEventImpactFilter={setEventImpactFilter} onNavigateToSettings={function(){setSettingsFocus("economicEvents");setTab("settings");}} onNavigateToPerformance={function(){setTab("performance");}} onNavigateToGoals={function(){setTab("goals");}} onWithdraw={function(amt){setPendingWithdrawAmount(amt);setTab("settings");}} bumpReloadKey={bumpReloadKey} tradeStatus={tradeStatus}/>}
            {tab==="trades"&&<TradesTab mobile={mobile} state={state} setState={setState} showForm={showForm} setShowForm={setShowForm} trade={trade} setTrade={setTrade} saveTrade={saveTrade} deleteTrade={deleteTrade} tradeStatus={tradeStatus} phase={phase} settings={settings} preCheckComplete={preCheckComplete} totalPnL={totalPnL} initialDate={tradesInitialDate} reloadKey={reloadKey} bumpReloadKey={bumpReloadKey} timezone={settings.timezone} liveTrades={liveTrades} openLiveTrade={function(lt){setLiveTradeManaging(lt);}} displayPosMin={dPosMin} displayPosMax={dPosMax} displayRiskMin={dRiskMin} displayRiskMax={dRiskMax} tradeOptions={tradeOptions} autoAddViolations={autoAddViolations} refreshHistory={bumpReloadKey} checklistVersion={checklistVersion}/>}
          </>);
        })()}
        {tab==="goals"&&<GoalsTab mobile={mobile} settings={settings} reloadKey={reloadKey} liveTotalPnL={totalPnL} tradeOptions={tradeOptions} state={state}/>}
        {tab==="performance"&&<PerformanceTab mobile={mobile} settings={settings} reloadKey={reloadKey} totalPnL={totalPnL} state={state} onNavigateToTrade={navigateToTrade}/>}
        {tab==="settings"&&<SettingsTab onSignOut={props.onSignOut} settings={settings} setSettings={setSettings} tradeOptions={tradeOptions} setTradeOptions={setTradeOptions} liveTotalPnL={totalPnL} initialTransferAmount={pendingWithdrawAmount} focusSection={settingsFocus} bumpReloadKey={bumpReloadKey} onChecklistChange={function(){setChecklistVersion(function(v){return v+1;});setState(function(s){var c=Object.assign({},s.preChecklist||{});var items=loadChecklistItems();items.forEach(function(it){if(c[it.key]==null)c[it.key]=false;});return Object.assign({},s,{preChecklist:c});});}}/>}
        {liveTradeManaging&&<ManageTradeView trade={liveTradeManaging} onClose={function(){setLiveTradeManaging(null);}} onSave={function(updated){saveTrade(updated);}} onDelete={function(){deleteTrade(liveTradeManaging.id);setLiveTradeManaging(null);}} settings={settings} tradeOptions={tradeOptions}/>}
      </div>
      </div>
      {/* CHANGED: Mobile bottom tab bar (shown only in mobile view). */}
      {mobile&&<div style={{position:"fixed",bottom:0,left:0,right:0,background:"#111118",borderTop:"1px solid #1e293b",zIndex:100,display:"flex",justifyContent:"space-around",padding:"6px 0 8px"}}>
        {[{id:"dashboard",label:"Home",icon:"⌂"},{id:"trades",label:"Journal",icon:"≡"},{id:"goals",label:"Goals",icon:"◎"},{id:"performance",label:"Stats",icon:"📈"},{id:"settings",label:"Settings",icon:"⚙"}].map(function(t){
          var active=tab===t.id;
          return <button key={t.id} onClick={function(){if(t.id!=="trades")setTradesInitialDate(null);setPendingWithdrawAmount(null);setSettingsFocus(null);setTab(t.id);}} style={{flex:1,background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",alignItems:"center",gap:2,color:active?"#a5b4fc":"#64748b",padding:"2px 0"}}>
            <span style={{fontSize:18,lineHeight:1}}>{t.icon}</span>
            <span style={{fontSize:9,fontWeight:active?700:500,letterSpacing:0.3}}>{t.label}</span>
          </button>;
        })}
      </div>}
    </div>
  );
}

export default App;
