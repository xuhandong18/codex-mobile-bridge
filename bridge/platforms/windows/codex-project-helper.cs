using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// Only native Codex project dialogs, their trust prompt, and the folder picker.
// No scripts, keyboard/mouse synthesis, file deletion, chat operations, or quit.
public static class CodexProjectHelper {
    static int pid, session; static long created; static string executable; static AutomationElement root;
    static readonly JavaScriptSerializer json=new JavaScriptSerializer();
    [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window,int id);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint owner);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int size);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window,uint message,IntPtr wParam,string value,uint flags,uint timeout,out UIntPtr result);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode)] static extern IntPtr ReadControlText(IntPtr window,uint message,IntPtr wParam,StringBuilder value,uint flags,uint timeout,out UIntPtr result);
    static void Owned() {
        using(var process=Process.GetProcessById(pid)) {
            if(process.HasExited||process.SessionId!=session||process.StartTime.ToUniversalTime().ToFileTimeUtc()!=created||
               !String.Equals(Path.GetFullPath(process.MainModule.FileName),executable,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Codex 运行实例已变化，尚未继续操作");
        }
    }
    static List<AutomationElement> Find(AutomationElement scope,ControlType type,params string[] names) {
        return scope.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,type))
            .Cast<AutomationElement>().Where(e=>names.Contains(e.Current.Name,StringComparer.Ordinal)).ToList();
    }
    static AutomationElement One(List<AutomationElement> elements,string reason) {
        if(elements.Count!=1)throw new InvalidOperationException(reason);return elements[0];
    }
    static T Wait<T>(Func<T> get) where T:class {
        var deadline=DateTime.UtcNow.AddSeconds(8);
        do {Owned();var value=get();if(value!=null)return value;Thread.Sleep(100);}while(DateTime.UtcNow<deadline);
        throw new InvalidOperationException("Codex 项目界面尚未就绪，请关闭电脑上的其他原生对话框后重试");
    }
    static void Invoke(AutomationElement element) {
        Owned();object pattern;
        if(!element.Current.IsEnabled)throw new InvalidOperationException("Codex 原生项目控件尚未启用："+element.Current.Name);
        if(element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) {((InvokePattern)pattern).Invoke();return;}
        if(element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)) {((ExpandCollapsePattern)pattern).Expand();return;}
        throw new InvalidOperationException("Codex 原生项目控件不可调用："+element.Current.Name);
    }
    static AutomationElement NativeDialog() {
        var all=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Window)).Cast<AutomationElement>();
        return all.SingleOrDefault(e=>(e.Current.Name=="编辑项目"||e.Current.Name=="Edit project")&&
            (e.Current.AutomationId??"").StartsWith("radix-",StringComparison.Ordinal));
    }
    static AutomationElement CreateDialog() {
        return root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Window))
            .Cast<AutomationElement>().SingleOrDefault(e=>new[]{"创建项目","新建项目","Create project","New project"}.Contains(e.Current.Name)&&
                (e.Current.AutomationId??"").StartsWith("radix-",StringComparison.Ordinal));
    }
    static AutomationElement FolderPicker() {
        return root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ClassNameProperty,"#32770"))
            .Cast<AutomationElement>().SingleOrDefault(e=>!e.Current.IsOffscreen);
    }
    static void CheckControl(IntPtr window,string expectedClass) {
        Owned();uint owner;GetWindowThreadProcessId(window,out owner);var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);
        if(window==IntPtr.Zero||owner!=pid||name.ToString()!=expectedClass)throw new InvalidOperationException("无法核验原生文件夹选择控件");
    }
    static void PickFolder(string path) {
        var picker=Wait(()=>FolderPicker());
        if(!new[]{"Select Project Root","Select Project Folder","选择项目根目录","选择项目文件夹"}.Contains(picker.Current.Name))
            throw new InvalidOperationException("原生文件夹选择窗口与项目操作不匹配");
        var handle=new IntPtr(picker.Current.NativeWindowHandle);CheckControl(handle,"#32770");
        var field=GetDlgItem(handle,1152);var select=GetDlgItem(handle,1);CheckControl(field,"Edit");CheckControl(select,"Button");
        UIntPtr result;
        if(SendMessageTimeout(field,0x000C,IntPtr.Zero,path,2,2000,out result)==IntPtr.Zero||result==UIntPtr.Zero)
            throw new InvalidOperationException("无法填写原生项目文件夹路径");
        var actual=new StringBuilder(32768);CheckControl(field,"Edit");
        if(ReadControlText(field,0x000D,new IntPtr(actual.Capacity),actual,2,2000,out result)==IntPtr.Zero)
            throw new InvalidOperationException("无法读取原生项目文件夹路径");
        if(!String.Equals(actual.ToString(),path,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("原生项目文件夹路径未能核对");
        CheckControl(select,"Button");
        if(SendMessageTimeout(select,0x00F5,IntPtr.Zero,null,2,2000,out result)==IntPtr.Zero)
            throw new InvalidOperationException("原生文件夹选择未确认，请关闭选择窗口后重试");
        Wait(()=>FolderPicker()==null?root:null);
    }
    static void Create(string name,string path,ref bool submitted) {
        if(String.IsNullOrWhiteSpace(name)||name.Length>120||name.Any(Char.IsControl)||!Path.IsPathRooted(path)||!Directory.Exists(path))
            throw new InvalidOperationException("项目名称或文件夹路径无效");
        path=Path.GetFullPath(path);
        if(CreateDialog()!=null||NativeDialog()!=null||FolderPicker()!=null)throw new InvalidOperationException("请先关闭电脑上已打开的项目对话框");
        var menu=One(root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.AutomationIdProperty,"application-menu-trigger-file-menu")).Cast<AutomationElement>().ToList(),"找不到唯一的 Codex 文件菜单");
        Invoke(menu);
        var createItem=Wait(()=>{
            var items=Find(root,ControlType.MenuItem,"New Project…","New Project...","新建项目…","新建项目...").Where(e=>!e.Current.IsOffscreen).ToList();
            return items.Count==1?items[0]:null;
        });
        Invoke(createItem);var dialog=Wait(()=>CreateDialog());
        var field=One(Find(dialog,ControlType.Edit,"项目名称","Project name"),"无法核验新项目名称输入框");
        // A fresh dialog must have no selected sources. Never reuse user input.
        if(dialog.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button)).Cast<AutomationElement>()
            .Any(e=>e.Current.Name.StartsWith("移除 ",StringComparison.Ordinal)||e.Current.Name.StartsWith("Remove ",StringComparison.Ordinal)))
            throw new InvalidOperationException("新项目窗口已包含文件夹，尚未继续创建");
        Invoke(One(Find(dialog,ControlType.Button,"添加","Add"),"无法核验添加项目文件夹按钮"));PickFolder(path);
        var basename=new DirectoryInfo(path).Name;
        dialog=Wait(()=>{
            var current=CreateDialog();if(current==null)return null;
            var sources=current.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button)).Cast<AutomationElement>()
                .Where(e=>e.Current.Name.StartsWith("移除 ",StringComparison.Ordinal)||e.Current.Name.StartsWith("Remove ",StringComparison.Ordinal)).ToList();
            return sources.Count==1&&new[]{"移除 "+basename,"Remove "+basename}.Contains(sources[0].Current.Name)?current:null;
        });
        field=One(Find(dialog,ControlType.Edit,"项目名称","Project name"),"无法核验项目名称输入框");
        object valueObject;
        if(!field.TryGetCurrentPattern(ValuePattern.Pattern,out valueObject))throw new InvalidOperationException("新项目名称不可编辑");
        ((ValuePattern)valueObject).SetValue(name);
        Wait(()=>((ValuePattern)field.GetCurrentPattern(ValuePattern.Pattern)).Current.Value==name?field:null);
        var commit=One(Find(dialog,ControlType.Button,"创建项目","Create project"),"无法核验创建项目按钮");
        Owned();submitted=true;Console.WriteLine(json.Serialize(new {phase="dispatching",pid=pid}));Console.Out.Flush();Invoke(commit);
        Console.WriteLine(json.Serialize(new {phase="submitted",pid=pid}));Console.Out.Flush();
    }
    // The observed native dialog exposes its complete paths as ListItems.
    // A name containing "trust" alone is only a reason to ask for manual help.
    static bool TrustTitle(string title) {
        return title=="信任此文件夹吗？";
    }
    static string FullDirectory(string path) {
        if(String.IsNullOrEmpty(path)||!Path.IsPathRooted(path))return null;
        if(path.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))path=@"\\"+path.Substring(8);
        else if(path.StartsWith(@"\\?\",StringComparison.Ordinal))path=path.Substring(4);
        if(!(path.StartsWith(@"\\",StringComparison.Ordinal)||path.Length>=3&&path[1]==':'&&(path[2]=='\\'||path[2]=='/')))return null;
        path=Path.GetFullPath(path);
        return path.Length>Path.GetPathRoot(path).Length?path.TrimEnd('\\','/'):path;
    }
    static string TrustCandidates(int count) {
        return count==1?null:"出现多个信任提示，请在电脑确认";
    }
    static string TrustMatch(string expected,string title,string[] paths,bool enabled,bool invokable,int buttonCount=1) {
        if(!TrustTitle(title))return "无法识别文件夹信任提示";
        if(paths.Length!=1)return "信任提示中没有唯一的完整目录";
        var actual=FullDirectory(paths[0]);
        if(actual==null||!String.Equals(actual,FullDirectory(expected),StringComparison.OrdinalIgnoreCase))return "信任提示的目录与本次项目不一致";
        if(buttonCount!=1||!enabled||!invokable)return "文件夹信任按钮不可调用";
        return null;
    }
    static List<AutomationElement> TrustDialogs() {
        return root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Window))
            .Cast<AutomationElement>().Where(e=>!e.Current.IsOffscreen&&
                (e.Current.Name.Contains("信任")||e.Current.Name.IndexOf("trust",StringComparison.OrdinalIgnoreCase)>=0)).ToList();
    }
    static void TrustReceipt(string phase,string path,string message="") {
        Console.WriteLine(json.Serialize(new {phase=phase,pid=pid,created=created,path=path,message=message}));Console.Out.Flush();
    }
    static void InvokeTrustOnce(ref bool attempted,Action invoke) {
        if(attempted)return;
        attempted=true;
        invoke();
    }
    static void WatchTrust(string path) {
        path=FullDirectory(path);
        if(path==null||!Directory.Exists(path))throw new InvalidOperationException("项目文件夹不存在或无法访问");
        Owned();
        if(TrustDialogs().Count!=0)throw new InvalidOperationException("请先在电脑处理已打开的文件夹信任提示，再创建项目");
        var commands=new BlockingCollection<string>();
        var input=new Thread(()=>{
            try {string line;while((line=Console.ReadLine())!=null)commands.Add(line);}
            finally {commands.CompleteAdding();}
        });input.IsBackground=true;input.Start();
        TrustReceipt("ready",path);
        string command;
        if(!commands.TryTake(out command,8000)||command!="arm"||commands.IsCompleted)return;
        Owned();
        if(TrustDialogs().Count!=0)throw new InvalidOperationException("请先在电脑处理已打开的文件夹信任提示，再创建项目");
        TrustReceipt("armed",path);
        var deadline=DateTime.UtcNow.AddSeconds(300);
        bool attempted=false,manual=false;
        while(DateTime.UtcNow<deadline&&!commands.IsCompleted) {
            if(commands.TryTake(out command,100))break; // stop or any invalid command disarms permanently
            Owned();
            if(attempted||manual)continue;
            var dialogs=TrustDialogs();if(dialogs.Count==0)continue;
            var candidateReason=TrustCandidates(dialogs.Count);
            if(candidateReason!=null) {TrustReceipt("manual",path,candidateReason);manual=true;continue;}
            var dialog=dialogs[0];
            if(!(dialog.Current.AutomationId??"").StartsWith("radix-",StringComparison.Ordinal)) {
                TrustReceipt("manual",path,"无法核验文件夹信任窗口，请在电脑确认");manual=true;continue;
            }
            var paths=dialog.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem))
                .Cast<AutomationElement>().Select(e=>e.Current.Name).ToArray();
            var buttons=Find(dialog,ControlType.Button,"信任文件夹").Where(e=>!e.Current.IsOffscreen).ToList();
            object pattern=null;
            bool invokable=buttons.Count==1&&buttons[0].TryGetCurrentPattern(InvokePattern.Pattern,out pattern);
            var reason=TrustMatch(path,dialog.Current.Name,paths,buttons.Count==1&&buttons[0].Current.IsEnabled,invokable,buttons.Count);
            if(reason!=null) {TrustReceipt("manual",path,reason+"，请在电脑确认");manual=true;continue;}
            // Re-read the same dialog immediately before dispatch, including its
            // live paths and button. Never retry an invocation with unknown outcome.
            Owned();
            if(commands.IsCompleted||commands.Count!=0)break;
            var live=TrustDialogs();
            if(live.Count!=1||!Automation.Compare(live[0],dialog)) {
                TrustReceipt("manual",path,"信任窗口已变化，请在电脑确认");manual=true;continue;
            }
            paths=dialog.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem))
                .Cast<AutomationElement>().Select(e=>e.Current.Name).ToArray();
            buttons=Find(dialog,ControlType.Button,"信任文件夹").Where(e=>!e.Current.IsOffscreen).ToList();
            pattern=null;invokable=buttons.Count==1&&buttons[0].TryGetCurrentPattern(InvokePattern.Pattern,out pattern);
            reason=TrustMatch(path,dialog.Current.Name,paths,buttons.Count==1&&buttons[0].Current.IsEnabled,invokable,buttons.Count);
            if(reason!=null) {TrustReceipt("manual",path,reason+"，请在电脑确认");manual=true;continue;}
            Owned();
            if(commands.IsCompleted||commands.Count!=0)break;
            try {
                InvokeTrustOnce(ref attempted,()=>{TrustReceipt("trust-dispatching",path);((InvokePattern)pattern).Invoke();});
                TrustReceipt("trusted",path);
            }
            catch(Exception) {TrustReceipt("unknown",path,"文件夹信任结果未确认，请在电脑检查；不会重复点击");}
        }
        TrustReceipt("stopped",path);
    }
    [STAThread] public static int Main(string[] args) {
        if(args.Length==1&&args[0]=="--self-check") {Console.WriteLine("codex-project-helper ok");return 0;}
        Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Length==1&&args[0]=="--test-trust-once") {
            bool attempted=false;int calls=0;bool fail=Console.In.ReadToEnd()=="fail";
            for(int i=0;i<2;i++)try {InvokeTrustOnce(ref attempted,()=>{calls++;if(fail)throw new InvalidOperationException();});}catch(InvalidOperationException) {}
            Console.WriteLine(json.Serialize(new {calls=calls}));return 0;
        }
        if(args.Length==1&&args[0]=="--test-trust-match") {
            var test=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
            var paths=((System.Collections.ArrayList)test["paths"]).Cast<string>().ToArray();
            var reason=TrustCandidates(Convert.ToInt32(test["dialogCount"]))??TrustMatch((string)test["path"],(string)test["title"],paths,(bool)test["enabled"],(bool)test["invokable"],Convert.ToInt32(test["buttonCount"]));
            Console.WriteLine(json.Serialize(new {reason=reason}));return 0;
        }
        bool submitted=false;string watchPath=null;
        try {
            var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadLine());
            pid=Convert.ToInt32(input["pid"]);created=Convert.ToInt64(input["created"]);
            executable=Path.GetFullPath((string)input["executable"]);session=Process.GetCurrentProcess().SessionId;
            var action=(string)input["action"];var name=(string)input["name"];
            if(action!="rename"&&action!="delete"&&action!="create"&&action!="watch-trust")throw new InvalidOperationException("不支持的项目操作");
            Owned();IntPtr hwnd;
            using(var process=Process.GetProcessById(pid))hwnd=process.MainWindowHandle;
            if(hwnd==IntPtr.Zero)throw new InvalidOperationException("Codex 主窗口不可用");
            root=AutomationElement.FromHandle(hwnd);
            if(action=="watch-trust") {watchPath=FullDirectory((string)input["path"]);WatchTrust(watchPath);return 0;}
            if(action=="create") {Create(name,(string)input["path"],ref submitted);return 0;}
            // Do not consume an existing edit dialog belonging to the user.
            if(NativeDialog()!=null)throw new InvalidOperationException("请先关闭电脑上已打开的项目编辑对话框");
            var button=One(Find(root,ControlType.Button,name+" 的项目操作","Project actions for "+name,name+" project actions"),
                "找不到唯一的原生项目菜单，请在电脑侧栏显示该项目后重试");
            Invoke(button);
            var menu=Wait(()=>{
                var removals=Find(root,ControlType.MenuItem,"移除项目","Remove project").Where(e=>!e.Current.IsOffscreen).ToList();
                return removals.Count==1?TreeWalker.ControlViewWalker.GetParent(removals[0]):null;
            });
            Invoke(One(Find(menu,ControlType.MenuItem,"编辑","Edit"),"项目编辑菜单不唯一"));
            var dialog=Wait(()=>NativeDialog());
            var field=One(Find(dialog,ControlType.Edit,"项目名称","Project name"),"无法核验项目名称输入框");
            object valueObject;
            if(!field.TryGetCurrentPattern(ValuePattern.Pattern,out valueObject)||((ValuePattern)valueObject).Current.Value!=name)
                throw new InvalidOperationException("原生项目身份已变化，尚未保存或移除");
            if(action=="rename") {
                var newName=(string)input["newName"];
                if(String.IsNullOrWhiteSpace(newName)||newName.Length>120)throw new InvalidOperationException("项目名称无效");
                ((ValuePattern)valueObject).SetValue(newName);
                Wait(()=>{
                    var current=One(Find(dialog,ControlType.Edit,"项目名称","Project name"),"项目名称输入框不唯一");
                    object updated;
                    return current.TryGetCurrentPattern(ValuePattern.Pattern,out updated)&&((ValuePattern)updated).Current.Value==newName?current:null;
                });
            }
            var commit=One(Find(dialog,ControlType.Button,action=="rename"?"保存":"移除本地项目",action=="rename"?"Save":"Remove local project"),"无法核验原生项目提交按钮");
            if(action=="delete") {
                // This button opens the native metadata-only removal prompt.
                Invoke(commit);
                var removal=Wait(()=>root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Window))
                    .Cast<AutomationElement>().SingleOrDefault(e=>(e.Current.AutomationId??"").StartsWith("radix-",StringComparison.Ordinal)&&
                        e.Current.Name.Contains(name)&&(e.Current.Name.StartsWith("移除",StringComparison.Ordinal)||e.Current.Name.StartsWith("Remove ",StringComparison.Ordinal))));
                var descriptions=removal.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Text))
                    .Cast<AutomationElement>().Select(e=>e.Current.Name).ToList();
                if(!descriptions.Any(text=>text.Contains("Files on your computer and existing chats won't be deleted.")||
                    text.Contains("文件")&&text.Contains("聊天")&&text.Contains("不会")))
                    throw new InvalidOperationException("无法确认操作会保留本机文件和聊天，尚未移除项目");
                commit=One(Find(removal,ControlType.Button,"移除项目","Remove project"),"无法核验仅移除项目记录的确认按钮");
            }
            Owned();submitted=true;
            Console.WriteLine(json.Serialize(new {phase="dispatching",pid=pid}));Console.Out.Flush();
            Invoke(commit);
            Console.WriteLine(json.Serialize(new {phase="submitted",pid=pid}));Console.Out.Flush();
            return 0;
        } catch(Exception error) {
            if(watchPath!=null) {TrustReceipt("failed",watchPath,error.Message);return 1;}
            Console.WriteLine(json.Serialize(new {phase=submitted?"unknown":"failed",pid=pid,error=error.Message}));
            return 1;
        }
    }
}
