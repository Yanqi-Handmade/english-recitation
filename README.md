# 英语背诵打卡 v7.2

修复 v7.1 页面加载后所有按钮无法点击的问题。

原因：
app.js 首次执行 save() 时引用了尚未初始化的 teacherLoggedIn，
浏览器触发 JavaScript ReferenceError，后续所有按钮事件函数均未加载。

v7.2 已将 teacherLoggedIn 提前初始化。

腾讯云函数 URL 已保留原配置，无需重新填写。
直接把本包解压后的文件覆盖上传到 GitHub 仓库根目录即可。
