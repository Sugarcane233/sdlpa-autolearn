' 隐藏启动器：用 WScript 以完全无窗口方式拉起 daemon.js
' 计划任务调用 wscript.exe + 本文件，全程不出现任何控制台窗口
Option Explicit

Dim shell, fso, root, nodeExe, script, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
script = root & "\daemon.js"

If Not fso.FileExists(nodeExe) Then
  WScript.Quit 1
End If
If Not fso.FileExists(script) Then
  WScript.Quit 2
End If

cmd = """" & nodeExe & """ """ & script & """"

' 0 = 隐藏窗口, False = 不等待
shell.CurrentDirectory = root
shell.Run cmd, 0, False
