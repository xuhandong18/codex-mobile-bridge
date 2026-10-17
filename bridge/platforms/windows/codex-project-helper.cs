using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// Only native Codex project metadata dialogs. No script execution, input
// synthesis, file deletion, chat operation, or process termination is allowed.
public static class CodexProjectHelper {
    static int pid, session; static long created; static string executable; static AutomationElement root;
    static readonly JavaScriptSerializer json=new JavaScriptSerializer();
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
    [STAThread] public static int Main(string[] args) {
        if(args.Length==1&&args[0]=="--self-check") {Console.WriteLine("codex-project-helper ok");return 0;}
        Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);
        bool submitted=false;
        try {
            var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
            pid=Convert.ToInt32(input["pid"]);created=Convert.ToInt64(input["created"]);
            executable=Path.GetFullPath((string)input["executable"]);session=Process.GetCurrentProcess().SessionId;
            var action=(string)input["action"];var name=(string)input["name"];
            if(action!="rename"&&action!="delete")throw new InvalidOperationException("不支持的项目操作");
            Owned();IntPtr hwnd;
            using(var process=Process.GetProcessById(pid))hwnd=process.MainWindowHandle;
            if(hwnd==IntPtr.Zero)throw new InvalidOperationException("Codex 主窗口不可用");
            root=AutomationElement.FromHandle(hwnd);
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
            Console.WriteLine(json.Serialize(new {phase=submitted?"unknown":"failed",pid=pid,error=error.Message}));
            return 1;
        }
    }
}
