# Windows 安装包打包说明

## 使用步骤

1. 下载安装 [Inno Setup](https://jrsoftware.org/isdl.php)（免费）

2. 把编译好的 `testagent.exe` 和 `opencode.cmd` 放到项目根目录的 `dist-win/` 文件夹下：
   ```
   dist-win/
     testagent.exe
     opencode.cmd
   installer/
     testagent-setup.iss
   ```

3. 用 Inno Setup 打开 `installer/testagent-setup.iss`，点 Build → Compile（或 `Ctrl+F9`）

4. 生成的安装包在 `installer/dist/testagent-setup-1.0.0.exe`，双击运行即可安装

## 安装包功能

- 默认安装到 `C:\Program Files\TestAgent`
- 安装时有勾选项 "Add to PATH"（默认勾选）
- 安装后 `testagent` 和 `opencode` 命令全局可用
- 卸载时自动从 PATH 移除，干净不留残留
- 需要管理员权限运行安装包（写 Program Files 和系统 PATH 都需要）
