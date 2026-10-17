package io.github.try2love.codexbridge;

import android.content.Context;
import android.graphics.Rect;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.WebView;
import org.json.JSONObject;

/** Adds draft-only actions to Android's existing text-selection toolbar. */
final class SelectionWebView extends WebView {
 interface Guard { boolean accepts(WebView view); }
 interface Labels { String text(String source); }
 private final Guard guard;
 private final Labels labels;
 private final int addId=View.generateViewId(),explainId=View.generateViewId();

 SelectionWebView(Context context,Guard guard,Labels labels){super(context);this.guard=guard;this.labels=labels;}

 @Override public ActionMode startActionMode(ActionMode.Callback callback){return startActionMode(callback,ActionMode.TYPE_PRIMARY);}
 @Override public ActionMode startActionMode(ActionMode.Callback callback,int type){
  return super.startActionMode(new SelectionCallback(callback),type);
 }

 private final class SelectionCallback extends ActionMode.Callback2 {
  private final ActionMode.Callback delegate;
  private boolean alive,reading,pending,canAdd,canExplain;
  private String token,pageUrl;
  SelectionCallback(ActionMode.Callback delegate){this.delegate=delegate;}
  private boolean current(String url){return alive&&guard.accepts(SelectionWebView.this)&&url!=null&&url.equals(getUrl());}
  private MenuItem item(Menu menu,int id,String label){
   MenuItem item=menu.findItem(id);
   if(item==null){item=menu.add(Menu.NONE,id,Menu.CATEGORY_SECONDARY,labels.text(label));item.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);}
   return item;
  }
  private void paint(Menu menu){
   item(menu,addId,"添加到会话").setVisible(canAdd);
   item(menu,explainId,"在侧边聊天中了解更多").setVisible(canExplain);
  }
  private void refresh(ActionMode mode,Menu menu){
   paint(menu);
   if(reading||pending||!hasWindowFocus()||!guard.accepts(SelectionWebView.this))return;
   reading=true;final String url=getUrl();
   evaluateJavascript("window.BridgeSelection?.capture() || null",result->{
    reading=false;if(!current(url))return;
    boolean add=false,explain=false;String next=null;
    try{JSONObject state=new JSONObject(result);next=state.optString("token",null);add=next!=null&&state.optBoolean("add");explain=next!=null&&state.optBoolean("explain");}catch(Exception ignored){}
    token=next;boolean changed=add!=canAdd||explain!=canExplain;canAdd=add;canExplain=explain;paint(menu);
    if(changed)mode.invalidate();
   });
  }
  @Override public boolean onCreateActionMode(ActionMode mode,Menu menu){
   pageUrl=getUrl();alive=delegate.onCreateActionMode(mode,menu);if(alive)refresh(mode,menu);return alive;
  }
  @Override public boolean onPrepareActionMode(ActionMode mode,Menu menu){
   boolean changed=delegate.onPrepareActionMode(mode,menu);refresh(mode,menu);return changed;
  }
  @Override public boolean onActionItemClicked(ActionMode mode,MenuItem item){
   int id=item.getItemId();
   if(id!=addId&&id!=explainId)return delegate.onActionItemClicked(mode,item);
   final String url=getUrl();
   if(pending||token==null||!current(url)||!hasWindowFocus()||id==addId&&!canAdd||id==explainId&&!canExplain)return true;
   pending=true;final String action=id==addId?"add":"explain";
   evaluateJavascript("window.BridgeSelection?.run("+JSONObject.quote(action)+","+JSONObject.quote(token)+") === true",result->{
    pending=false;if(current(url)&&"true".equals(result))mode.finish();
   });
   return true;
  }
  @Override public void onDestroyActionMode(ActionMode mode){
   alive=false;
   try{delegate.onDestroyActionMode(mode);}
   finally{if(token!=null&&pageUrl!=null&&pageUrl.equals(getUrl())&&guard.accepts(SelectionWebView.this))evaluateJavascript("window.BridgeSelection?.release("+JSONObject.quote(token)+")",null);}
  }
  @Override public void onGetContentRect(ActionMode mode,View view,Rect rect){
   if(delegate instanceof ActionMode.Callback2)((ActionMode.Callback2)delegate).onGetContentRect(mode,view,rect);
   else super.onGetContentRect(mode,view,rect);
  }
 }
}
