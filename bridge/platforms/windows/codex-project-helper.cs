using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// Only native Codex project dialogs and the folder picker opened by this helper.
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
    [STAThread] public static int Main(string[] args) {
        if(args.Length==1&&args[0]=="--self-check") {Console.WriteLine("codex-project-helper ok");return 0;}
        Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);
        bool submitted=false;
        try {
            var input=json.Deserialize<Dictionary<string,object>>(Console.In.ReadToEnd());
            pid=Convert.ToInt32(input["pid"]);created=Convert.ToInt64(input["created"]);
            executable=Path.GetFullPath((string)input["executable"]);session=Process.GetCurrentProcess().SessionId;
            var action=(string)input["action"];var name=(string)input["name"];
            if(action!="rename"&&action!="delete"&&action!="create")throw new InvalidOperationException("不支持的项目操作");
            Owned();IntPtr hwnd;
            using(var process=Process.GetProcessById(pid))hwnd=process.MainWindowHandle;
            if(hwnd==IntPtr.Zero)throw new InvalidOperationException("Codex 主窗口不可用");
            root=AutomationElement.FromHandle(hwnd);
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
            Console.WriteLine(json.Serialize(new {phase=submitted?"unknown":"failed",pid=pid,error=error.Message}));
            return 1;
        }
    }
}
