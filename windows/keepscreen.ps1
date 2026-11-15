# 防睡眠：调用 SetThreadExecutionState 持续声明"系统+显示需要"
# 只在本进程存活期间生效，进程退出后系统恢复正常电源策略
$sig = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$t = Add-Type -MemberDefinition $sig -Name 'ES' -Namespace 'Win' -PassThru
$ES_CONTINUOUS      = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001
# 不包含 ES_DISPLAY_REQUIRED，屏幕可以正常关闭，但系统不睡眠
while ($true) {
  [void]$t::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
  Start-Sleep -Seconds 50
}
