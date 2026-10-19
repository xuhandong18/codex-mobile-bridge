package io.github.try2love.codexbridge;

import android.app.*;
import android.content.*;
import android.os.Bundle;
import android.webkit.*;
import java.io.*;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import org.json.*;

/** Real APK/WebView/service/system notifications; only the gateway is synthetic. */
public final class NotificationFlowInstrumentation extends Instrumentation {
 static final String NAME="codex_mobile_session_0123456789abcdef01234567";
 static final String THREAD="11111111-1111-4111-8111-111111111111";
 Activity activity;WebView web;int checks;
 static final class Gateway implements AutoCloseable {
  final ServerSocket listener=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"));
  final ExecutorService workers=Executors.newCachedThreadPool();
  volatile long cursor=200;volatile boolean read;volatile int authReads;
  Gateway()throws IOException {workers.submit(()->{while(!listener.isClosed())try{Socket socket=listener.accept();workers.submit(()->respond(socket));}catch(IOException ignored){}});}
  String origin(){return "http://127.0.0.1:"+listener.getLocalPort();}
  void respond(Socket socket){try(Socket current=socket){
   BufferedReader input=new BufferedReader(new InputStreamReader(current.getInputStream(),StandardCharsets.UTF_8));
   String line=input.readLine();if(line==null)return;String target=line.split(" ")[1];while((line=input.readLine())!=null&&!line.isEmpty()){}
   String body,type="application/json";
   if(target.equals("/")){type="text/html; charset=utf-8";body="<!doctype html><meta charset='utf-8'><div id='app'>Synthetic notification fixture</div>";}
   else if(target.equals("/api/auth")){authReads++;body=new JSONObject().put("authenticated",true).put("trustedDevice",false).put("cookieName",NAME).put("csrf","fixture").toString();}
   else if(target.startsWith("/api/mobile/events")){
    long after=target.contains("?after=")?Long.parseLong(target.split("after=")[1]):0;
    JSONArray events=new JSONArray();if(cursor>after)events.put(new JSONObject().put("id","fixture-"+cursor).put("sequence",cursor).put("threadId",THREAD).put("host","local").put("kind","completion").put("title","Codex 运行已完成").put("androidTitle","通知链路回归 · 已完成").put("body","Synthetic completed task").put("unread",!read).put("createdAt",System.currentTimeMillis()/1000.0));
    body=new JSONObject().put("enabled",true).put("streamId","fixture-stream").put("cursor",cursor).put("events",events).put("clients",new JSONArray().put(new JSONObject().put("id","codex").put("enabled",true).put("unread",read?0:1))).toString();
   }else body="{}";
   byte[] bytes=body.getBytes(StandardCharsets.UTF_8);
   current.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: "+type+"\r\nContent-Length: "+bytes.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));current.getOutputStream().write(bytes);
  }catch(Exception ignored){}}
  public void close()throws IOException {listener.close();workers.shutdownNow();}
 }
 void check(boolean value,String label){if(!value)throw new AssertionError(label);checks++;}
 void until(BooleanSupplier test)throws Exception {long deadline=System.currentTimeMillis()+20000;while(!test.getAsBoolean()){if(System.currentTimeMillis()>deadline)throw new AssertionError("Timed out waiting for fixture state");Thread.sleep(40);}}
 String js(String script)throws Exception {CountDownLatch done=new CountDownLatch(1);String[] value={null};runOnMainSync(()->web.evaluateJavascript(script,result->{value[0]=result;done.countDown();}));if(!done.await(10,TimeUnit.SECONDS))throw new AssertionError("WebView script timed out");return value[0];}
 void cookie(String origin,String token)throws Exception {CountDownLatch done=new CountDownLatch(1);runOnMainSync(()->CookieManager.getInstance().setCookie(origin+"/",NAME+"="+token+"; Path=/; HttpOnly",ok->done.countDown()));if(!done.await(10,TimeUnit.SECONDS))throw new AssertionError("Cookie setup timed out");}
 @Override public void onCreate(Bundle args){super.onCreate(args);start();}
 @Override public void onStart(){Bundle result=new Bundle();try(Gateway gateway=new Gateway()){
  Context context=getTargetContext();String origin=gateway.origin();android.content.SharedPreferences prefs=context.getSharedPreferences("bridge",0);
  prefs.edit().clear().putBoolean("alerts",true).putStringSet("origins",new HashSet<>(Collections.singleton(origin))).putString("cookieName:"+origin,NAME).commit();
  cookie(origin,"fixture-first-binding");EventClient.setName(origin,NAME);
  NotificationManager manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);manager.cancelAll();
  activity=startActivitySync(new Intent(context,MainActivity.class).putExtra("origin",origin).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
  java.lang.reflect.Field field=MainActivity.class.getDeclaredField("web");field.setAccessible(true);web=(WebView)field.get(activity);
  until(()->prefs.getLong("cursor:"+origin,0)==200&&gateway.authReads>0);
  check(manager.areNotificationsEnabled(),"OS notification permission granted");
  check(manager.getNotificationChannel("foreground-tasks").getImportance()==NotificationManager.IMPORTANCE_HIGH,"Task channel has heads-up importance");
  check(manager.getActiveNotifications().length==0,"Initial history does not notify");
  gateway.cursor=201;js("document.dispatchEvent(new Event('bridge-authenticated'))");until(()->prefs.getLong("cursor:"+origin,0)==201);
  check(manager.getActiveNotifications().length==1,"Repeated session persistence posts a real system notification");
  check(manager.getActiveNotifications()[0].getNotification().extras.getCharSequence(Notification.EXTRA_TITLE).toString().equals("通知链路回归 · 已完成"),"System notification contains compact chat title and full status");
  gateway.cursor=202;js("document.dispatchEvent(new Event('bridge-authenticated'))");until(()->prefs.getLong("cursor:"+origin,0)==202);
  check(manager.getActiveNotifications().length==2,"Subsequent repeated persistence keeps task notifications live");
  gateway.read=true;gateway.cursor=203;js("document.dispatchEvent(new Event('bridge-authenticated'))");until(()->prefs.getLong("cursor:"+origin,0)==203);
  check(manager.getActiveNotifications().length==2,"Already read events do not produce a new system notification");
  cookie(origin,"fixture-replacement-binding");gateway.read=false;gateway.cursor=204;js("document.dispatchEvent(new Event('bridge-authenticated'))");until(()->prefs.getLong("cursor:"+origin,0)==204);
  check(manager.getActiveNotifications().length==2,"Replacement login establishes a fresh baseline");
  gateway.cursor=205;js("document.dispatchEvent(new Event('bridge-authenticated'))");until(()->prefs.getLong("cursor:"+origin,0)==205);
  check(manager.getActiveNotifications().length==3,"New-login notifications resume after its own baseline");
  result.putString("stream","PASS real APK/WebView notification flow: "+checks+" assertions\n");
  runOnMainSync(()->activity.finish());finish(Activity.RESULT_OK,result);
 }catch(Throwable error){result.putString("stream",android.util.Log.getStackTraceString(error));if(activity!=null)runOnMainSync(()->activity.finish());finish(Activity.RESULT_CANCELED,result);}}
}
