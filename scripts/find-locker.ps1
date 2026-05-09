# 查找哪些进程持有 release 目录下的文件句柄
$target = 'e:\ApkInstallHelper\release'
Get-Process | ForEach-Object {
  $proc = $_
  try {
    $modules = $proc.Modules
    foreach ($m in $modules) {
      if ($m.FileName -like "$target*") {
        Write-Output ("PID={0,-6} NAME={1,-25} MODULE={2}" -f $proc.Id, $proc.ProcessName, $m.FileName)
        break
      }
    }
  } catch {}
}
Write-Output 'done.'
