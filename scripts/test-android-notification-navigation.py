#!/usr/bin/env python3
"""Exercise the real notification intent handler with an isolated Android UI fixture."""
from pathlib import Path
import os
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.tmp/android-notification-navigation'
WORK.mkdir(parents=True, exist_ok=True)
source = (ROOT / 'mobile/android/src/io/github/try2love/codexbridge/MainActivity.java').read_text(encoding='utf-8')
methods = source[source.index(' boolean openIntent('):source.index(' @Override protected void onNewIntent(')]
java = r'''
import io.github.try2love.codexbridge.GatewayURL;
import java.util.*;
class Intent {
 Map<String,String> extras=new HashMap<>();Uri data;
 Intent putExtra(String k,String v){extras.put(k,v);return this;}
 String getStringExtra(String k){return extras.get(k);}Uri getData(){return data;}
}
class Uri {
 java.net.URI value;Uri(String s){value=java.net.URI.create(s);}static Uri parse(String s){return new Uri(s);}
 String getScheme(){return value.getScheme();}String getHost(){return value.getHost();}String getEncodedFragment(){return value.getRawFragment();}
 String getQueryParameter(String name){for(String part:value.getRawQuery().split("&")){String[] pair=part.split("=",2);if(pair[0].equals(name))return java.net.URLDecoder.decode(pair[1],java.nio.charset.StandardCharsets.UTF_8);}return null;}
}
class JSONObject {static String quote(String s){return "\""+s.replace("\\","\\\\").replace("\"","\\\"")+"\"";}}
class WebView {String url,script;WebView(String u){url=u;}String getUrl(){return url;}void evaluateJavascript(String s,Object callback){script=s;}}
class MainActivity {
 String origin="https://gateway.test";Set<String> computers=new HashSet<>(Set.of(origin,"https://other.test"));WebView web;int connections;String last;List<String> messages=new ArrayList<>();
 Set<String> saved(){return computers;}String L(String s){return s;}void message(String s){messages.add(s);}void resetExitGesture(){}
 void connect(String target)throws Exception{connections++;last=target;origin=GatewayURL.targetBase(target);web=new WebView(target);}
 METHODS
}
public class NotificationNavigationTests {
 static void check(boolean ok,String reason){if(!ok)throw new AssertionError(reason);}
 static Intent note(String base,String thread,String host){return new Intent().putExtra("origin",base).putExtra("thread",thread).putExtra("host",host);}
 public static void main(String[] args)throws Exception {
  String base="https://gateway.test",a="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",b="bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  MainActivity app=new MainActivity();check(app.openIntent(note(base,a,"local")),"cold notification opens");check(app.connections==1,"cold start creates page");
  check(app.openIntent(note(base,b,"local")),"warm notification handled");check(app.connections==1,"notification must reuse the existing WebView and preserve unsent input");check(app.web.script.contains(b)&&app.web.script.contains("BridgeNavigation"),"warm notification routes through the current page");
  check(app.openIntent(note(base,"claude/chat","desktop:claude")),"desktop provider accepted");check(app.web.script.contains("claude%2Fchat~desktop%3Aclaude"),"provider and chat are encoded");
  check(!app.openIntent(note("https://untrusted.test",a,"local"))&&app.connections==1,"unpaired origin rejected");
  check(!app.openIntent(note(base,"invalid","local"))&&app.connections==1,"malformed chat rejected");
  check(app.openIntent(note("https://other.test",a,"local"))&&app.connections==2,"another saved computer gets its own page");
  app.web=new WebView("https://untrusted.test/");check(app.openIntent(note("https://other.test",a,"local"))&&app.connections==3,"foreign current page cannot receive injected navigation");
  System.out.println("PASS Android cold/warm notification navigation, provider routing, pairing and origin boundaries");
 }
}
'''.replace('METHODS', methods)
(WORK / 'NotificationNavigationTests.java').write_text(java, encoding='utf-8')
def java_tool(name):
    return str(Path(os.environ['JAVA_HOME']) / 'bin' / name) if os.environ.get('JAVA_HOME') else shutil.which(name)
subprocess.run([java_tool('javac'), '-encoding', 'UTF-8', '-d', str(WORK),
                str(ROOT / 'mobile/android/src/io/github/try2love/codexbridge/GatewayURL.java'),
                str(WORK / 'NotificationNavigationTests.java')], check=True)
subprocess.run([java_tool('java'), '-cp', str(WORK), 'NotificationNavigationTests'], check=True)
