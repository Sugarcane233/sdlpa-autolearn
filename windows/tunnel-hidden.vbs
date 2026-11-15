' 无窗口启动 tunnel.js（ngrok 公网映射）
' 由计划任务 SDLPA_Tunnel 调用，用法同 daemon-hidden.vbs
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' 0 = 隐藏窗口，False = 不等待
sh.Run """C:\Program Files\nodejs\node.exe"" """ & dir & "\tunnel.js""", 0, False
