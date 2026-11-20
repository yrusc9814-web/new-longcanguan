# @dafan/mobile-app

Google2 生产页与离线资源来自 `da-fan-xiao-guan@e778d3b`。两张品牌母图位于 `resources/`。

在仓库根目录执行 `npm ci`，然后在本包目录执行：

```sh
npm run build
npx cap sync android
```

编译 Android 调试包需 JDK 21 与 Android SDK Platform 35。进入 `android/`，在 Windows 执行 `gradlew.bat assembleDebug`，在 macOS 或 Linux 执行 `./gradlew assembleDebug`。

`android.overridePathCheck=true` 允许 Gradle 在包含中文的工作区路径中构建。`npm test` 会先构建 Web 产物，再检查本地资产和原生壳配置。
