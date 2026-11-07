#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <CFNetwork/CFNetwork.h>
#import <arpa/inet.h>
#import <signal.h>

static NSString *const AppName = @"抖音获客助手";

static NSString *Origin(NSURL *url) {
    if (!url || url.user.length || url.password.length || !url.host.length) return nil;
    NSString *scheme = url.scheme.lowercaseString;
    if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) return nil;
    NSNumber *port = url.port;
    BOOL standard = !port || ([scheme isEqualToString:@"https"] && port.integerValue == 443) ||
        ([scheme isEqualToString:@"http"] && port.integerValue == 80);
    return [NSString stringWithFormat:@"%@://%@%@", scheme, url.host.lowercaseString,
            standard ? @"" : [NSString stringWithFormat:@":%@", port]];
}

static NSDictionary *FirstProxy(NSDictionary *settings, NSURL *url) {
    NSArray *proxies = CFBridgingRelease(CFNetworkCopyProxiesForURL((__bridge CFURLRef)url, (__bridge CFDictionaryRef)settings));
    return [proxies.firstObject isKindOfClass:NSDictionary.class] ? proxies.firstObject : nil;
}

static NSString *ProxyAddress(NSDictionary *proxy, NSDictionary *settings, NSString *scheme, NSString **problem) {
    NSString *type = proxy[(__bridge NSString *)kCFProxyTypeKey];
    if (![type isEqual:(__bridge NSString *)kCFProxyTypeHTTP] && ![type isEqual:(__bridge NSString *)kCFProxyTypeHTTPS]) {
        if (problem) *problem = @"当前系统代理需要自动配置或 SOCKS，助手暂不支持这种连接方式。未改动系统代理，请联系维护者配置兼容接入。";
        return nil;
    }
    // CFNetwork deliberately does not retrieve Keychain credentials. Never guess or copy proxy authentication.
    for (NSString *key in @[[scheme stringByAppendingString:@"User"], [scheme stringByAppendingString:@"Password"], [scheme stringByAppendingString:@"ProxyAuthenticated"]]) {
        id value = settings[key];
        if (([value isKindOfClass:NSString.class] && [value length]) || ([value isKindOfClass:NSNumber.class] && [value boolValue])) {
            if (problem) *problem = @"当前系统代理需要身份认证，助手不能代用钥匙串中的代理凭证。请联系维护者配置兼容接入。";
            return nil;
        }
    }
    if (proxy[(__bridge NSString *)kCFProxyUsernameKey] || proxy[(__bridge NSString *)kCFProxyPasswordKey]) {
        if (problem) *problem = @"当前系统代理需要身份认证，助手暂不支持传递代理账号或密码。";
        return nil;
    }
    NSString *host = proxy[(__bridge NSString *)kCFProxyHostNameKey];
    NSNumber *port = proxy[(__bridge NSString *)kCFProxyPortNumberKey];
    if (![host isKindOfClass:NSString.class] || !host.length || ![port isKindOfClass:NSNumber.class] ||
        port.integerValue < 1 || port.integerValue > 65535 || port.doubleValue != port.integerValue) {
        if (problem) *problem = @"系统代理地址或端口无效，助手未启用代理。";
        return nil;
    }
    NSString *normalized = host;
    if ([normalized hasPrefix:@"["] && [normalized hasSuffix:@"]"]) normalized = [normalized substringWithRange:NSMakeRange(1, normalized.length - 2)];
    if ([normalized containsString:@":"]) {
        struct in6_addr address;
        if (inet_pton(AF_INET6, normalized.UTF8String, &address) != 1) {
            if (problem) *problem = @"系统代理地址格式不受支持，助手未启用代理。";
            return nil;
        }
        normalized = [NSString stringWithFormat:@"[%@]", normalized];
    } else {
        NSRegularExpression *hostname = [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$" options:0 error:nil];
        if (![hostname numberOfMatchesInString:normalized options:0 range:NSMakeRange(0, normalized.length)]) {
            if (problem) *problem = @"系统代理地址格式不受支持，助手未启用代理。";
            return nil;
        }
    }
    // macOS's HTTPS proxy is an HTTP CONNECT tunnel, not an HTTPS connection to the proxy itself.
    return [NSString stringWithFormat:@"http://%@:%@", normalized, port];
}

static NSDictionary<NSString *, NSString *> *ProxyEnvironmentForURL(NSDictionary *settings, NSURL *siteURL, NSString **problem) {
    if (problem) *problem = nil;
    NSMutableDictionary *environment = [@{@"NO_PROXY": @"localhost,127.0.0.1,::1,[::1]"} mutableCopy];
    if (!settings.count) return environment;
    if ([settings[(__bridge NSString *)kCFNetworkProxiesProxyAutoConfigEnable] boolValue] ||
        [settings[(__bridge NSString *)kCFNetworkProxiesProxyAutoDiscoveryEnable] boolValue]) {
        if (problem) *problem = @"系统正在使用自动代理（PAC/WPAD）。助手暂不能把自动规则转换为 Node 代理，未改动系统设置，请联系维护者配置兼容接入。";
        return nil;
    }
    // All remote Node requests go to this configured HTTPS workbench; Chromium uses its own system proxy.
    // Resolve the workbench through CFNetwork so scoped settings and system bypass rules remain authoritative.
    NSDictionary *https = FirstProxy(settings, siteURL);
    if (!https || [https[(__bridge NSString *)kCFProxyTypeKey] isEqual:(__bridge NSString *)kCFProxyTypeNone]) return environment;
    NSString *secureProxy = ProxyAddress(https, settings, @"HTTPS", problem);
    if (!secureProxy) return nil;
    environment[@"HTTPS_PROXY"] = secureProxy;
    NSURLComponents *httpURL = [NSURLComponents componentsWithURL:siteURL resolvingAgainstBaseURL:NO];
    httpURL.scheme = @"http"; httpURL.port = nil;
    NSDictionary *http = FirstProxy(settings, httpURL.URL);
    if (http && ![http[(__bridge NSString *)kCFProxyTypeKey] isEqual:(__bridge NSString *)kCFProxyTypeNone]) {
        NSString *plainProxy = ProxyAddress(http, settings, @"HTTP", problem);
        if (!plainProxy) return nil;
        environment[@"HTTP_PROXY"] = plainProxy;
    }
    // Only the first CFNetwork route is used. Unsupported SOCKS fallbacks are never guessed or attempted.
    // When HTTPS is direct, return above without HTTP_PROXY to prevent Node falling back to it for HTTPS.
    return environment;
}

@interface Launcher : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSTask *server;
@property(nonatomic, strong) NSPipe *outputPipe;
@property(nonatomic, strong) NSMutableData *outputBuffer;
@property(nonatomic, copy) NSString *localOrigin;
@property(nonatomic, copy) NSString *siteOrigin;
@property(nonatomic) BOOL quitting;
@property(nonatomic) BOOL failed;
@end

@implementation Launcher
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    (void)notification;
    NSString *bundleID = NSBundle.mainBundle.bundleIdentifier;
    for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleID]) {
        if (application.processIdentifier != NSProcessInfo.processInfo.processIdentifier && !application.terminated) {
            [application activateWithOptions:NSApplicationActivateAllWindows];
            [NSApp terminate:nil];
            return;
        }
    }
    [self makeMenus];
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1120, 780)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = AppName;
    self.window.minSize = NSMakeSize(720, 560);
    self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    [self.window center];
    NSTextField *status = [NSTextField labelWithString:@"正在启动助手…"];
    status.font = [NSFont systemFontOfSize:18 weight:NSFontWeightMedium];
    status.alignment = NSTextAlignmentCenter;
    status.frame = NSMakeRect(0, 360, 1120, 40);
    status.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin | NSViewMaxYMargin;
    [self.window.contentView addSubview:status];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activate];
    [self startServer];
}

- (void)makeMenus {
    NSMenu *menu = [[NSMenu alloc] init];
    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [menu addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:AppName];
    [appMenu addItemWithTitle:[@"退出" stringByAppendingString:AppName] action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;
    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    [menu addItem:editItem];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"编辑"];
    [edit addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
    [edit addItem:[NSMenuItem separatorItem]];
    [edit addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
    [edit addItemWithTitle:@"复制" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = edit;
    NSApp.mainMenu = menu;
}

- (void)startServer {
    NSString *resources = NSBundle.mainBundle.resourcePath;
    NSData *siteData = [NSData dataWithContentsOfFile:[resources stringByAppendingPathComponent:@"site.json"]];
    id settings = siteData ? [NSJSONSerialization JSONObjectWithData:siteData options:0 error:nil] : nil;
    NSString *configured = [settings isKindOfClass:NSDictionary.class] && [settings[@"origin"] isKindOfClass:NSString.class] ? settings[@"origin"] : nil;
    NSURL *siteURL = configured ? [NSURL URLWithString:configured] : nil;
    self.siteOrigin = [siteURL.scheme.lowercaseString isEqualToString:@"https"] ? Origin(siteURL) : nil;
    if (!self.siteOrigin) { [self showFailure:@"应用配置不完整，请重新安装助手。"]; return; }
    NSDictionary *systemProxy = CFBridgingRelease(CFNetworkCopySystemProxySettings());
    NSString *proxyProblem = nil;
    NSDictionary *proxyEnvironment = ProxyEnvironmentForURL(systemProxy, siteURL, &proxyProblem);
    if (!proxyEnvironment) { [self showFailure:proxyProblem]; return; }

    self.server = [[NSTask alloc] init];
    self.server.executableURL = [NSURL fileURLWithPath:[resources stringByAppendingPathComponent:@"runtime/node"]];
    self.server.arguments = @[@"--use-env-proxy", [resources stringByAppendingPathComponent:@"bridge/desktop-server.mjs"], @"--no-browser"];
    self.server.currentDirectoryURL = [NSURL fileURLWithPath:[resources stringByAppendingPathComponent:@"bridge"]];
    NSMutableDictionary *environment = [@{
        @"HOME": NSHomeDirectory(), @"USER": NSUserName(), @"LOGNAME": NSUserName(),
        @"PATH": @"/usr/bin:/bin:/usr/sbin:/sbin", @"LANG": @"zh_CN.UTF-8", @"TMPDIR": NSTemporaryDirectory(),
        @"PLAYWRIGHT_BROWSERS_PATH": [resources stringByAppendingPathComponent:@"browsers"],
        @"DESKTOP_SITE_ORIGIN": self.siteOrigin, @"DESKTOP_NATIVE_APP": @"1"
    } mutableCopy];
    [environment addEntriesFromDictionary:proxyEnvironment];
    self.server.environment = environment;
    self.server.standardInput = NSFileHandle.fileHandleWithNullDevice;
    self.server.standardError = NSFileHandle.fileHandleWithNullDevice;
    self.outputPipe = [NSPipe pipe];
    self.server.standardOutput = self.outputPipe;
    self.outputBuffer = [NSMutableData data];
    __weak Launcher *weakSelf = self;
    self.outputPipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *chunk = handle.availableData;
        if (!chunk.length) { handle.readabilityHandler = nil; return; }
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf receiveOutput:chunk]; });
    };
    self.server.terminationHandler = ^(NSTask *task) {
        (void)task;
        dispatch_async(dispatch_get_main_queue(), ^{
            Launcher *self = weakSelf;
            self.outputPipe.fileHandleForReading.readabilityHandler = nil;
            if (self.quitting) [NSApp replyToApplicationShouldTerminate:YES];
            else [self showFailure:@"助手服务已停止。请关闭并重新打开应用；若仍无法启动，请重新安装助手。"];
        });
    };
    if (![self.server launchAndReturnError:nil]) {
        self.outputPipe.fileHandleForReading.readabilityHandler = nil;
        [self showFailure:@"无法启动本机助手，请重新安装后再试。"];
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        Launcher *self = weakSelf;
        if (self && !self.localOrigin && !self.quitting) [self showFailure:@"助手启动超时，请关闭后重新打开。"];
    });
}

- (void)receiveOutput:(NSData *)chunk {
    // The ready URL contains a capability token. It stays in memory and is never logged or shown as text.
    if (self.quitting || self.localOrigin || self.failed) return;
    if (self.outputBuffer.length + chunk.length > 65536) { [self showFailure:@"助手启动响应异常，请重新打开应用。"]; return; }
    [self.outputBuffer appendData:chunk];
    while (self.outputBuffer.length) {
        const unsigned char *bytes = self.outputBuffer.bytes;
        NSUInteger end = 0;
        while (end < self.outputBuffer.length && bytes[end] != '\n') end++;
        if (end == self.outputBuffer.length) return;
        NSData *line = [self.outputBuffer subdataWithRange:NSMakeRange(0, end)];
        [self.outputBuffer replaceBytesInRange:NSMakeRange(0, end + 1) withBytes:NULL length:0];
        id message = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
        if (![message isKindOfClass:NSDictionary.class] || ![message[@"event"] isEqual:@"ready"]) continue;
        NSString *value = [message[@"url"] isKindOfClass:NSString.class] ? message[@"url"] : nil;
        NSURL *url = value ? [NSURL URLWithString:value] : nil;
        if (!url || ![url.scheme isEqualToString:@"http"] || ![url.host isEqualToString:@"127.0.0.1"] ||
            url.user.length || url.password.length || url.port.integerValue < 1 || url.port.integerValue > 65535 ||
            ![url.path isEqualToString:@"/"] || url.query.length || !url.fragment.length) {
            [self showFailure:@"助手返回的本机地址无效，请重新打开应用。"];
            return;
        }
        self.localOrigin = Origin(url);
        [self.outputBuffer setLength:0];
        WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
        configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:configuration];
        self.webView.navigationDelegate = self;
        self.webView.UIDelegate = self;
        self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        self.window.contentView = self.webView;
        [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
        return;
    }
}

- (BOOL)isLocalURL:(NSURL *)url { return self.localOrigin && [Origin(url) isEqualToString:self.localOrigin]; }
- (BOOL)mayOpenExternalURL:(NSURL *)url {
    if (![url.scheme.lowercaseString isEqualToString:@"https"] || url.user.length || url.password.length) return NO;
    if ([Origin(url) isEqualToString:self.siteOrigin]) return YES;
    NSString *host = url.host.lowercaseString;
    return (!url.port || url.port.integerValue == 443) &&
        ([host isEqualToString:@"douyin.com"] || [host hasSuffix:@".douyin.com"]);
}
- (void)openExternalURL:(NSURL *)url {
    if ([self mayOpenExternalURL:url]) [NSWorkspace.sharedWorkspace openURL:url];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    (void)webView;
    if ([self isLocalURL:action.request.URL]) { decisionHandler(WKNavigationActionPolicyAllow); return; }
    if (action.navigationType == WKNavigationTypeLinkActivated || !action.targetFrame) [self openExternalURL:action.request.URL];
    decisionHandler(WKNavigationActionPolicyCancel);
}
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    (void)configuration; (void)features;
    if ([self isLocalURL:action.request.URL]) [webView loadRequest:action.request];
    else [self openExternalURL:action.request.URL];
    return nil;
}
- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> * _Nullable URLs))completionHandler {
    (void)webView; (void)parameters;
    if (![self isLocalURL:frame.request.URL]) { completionHandler(nil); return; }
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = @"选择工作台下载的配对配置";
    panel.allowedContentTypes = @[UTTypeJSON];
    panel.canChooseDirectories = NO;
    panel.canChooseFiles = YES;
    panel.allowsMultipleSelection = NO;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        NSURL *url = panel.URL;
        completionHandler(response == NSModalResponseOK && url.isFileURL && [url.pathExtension.lowercaseString isEqualToString:@"json"] ? @[url] : nil);
    }];
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView; (void)navigation;
    if (error.code != NSURLErrorCancelled && !self.quitting) [self showFailure:@"无法打开助手界面，请关闭后重新打开应用。"];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    (void)webView;
    if (!self.quitting) [self showFailure:@"助手界面已停止，请关闭后重新打开应用。"];
}
- (void)showFailure:(NSString *)message {
    if (self.failed || self.quitting) return;
    self.failed = YES;
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"助手暂时无法运行";
    alert.informativeText = message;
    [alert addButtonWithTitle:@"退出"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) { (void)result; [NSApp terminate:nil]; }];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)application { (void)application; return YES; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)application {
    (void)application;
    self.quitting = YES;
    if (!self.server.running) return NSTerminateNow;
    // Only signal the NSTask started by this instance; never kill processes by name or process group.
    [self.server terminate];
    __weak Launcher *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        Launcher *self = weakSelf;
        if (self.server.running) kill(self.server.processIdentifier, SIGKILL);
    });
    return NSTerminateLater;
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        __attribute__((objc_precise_lifetime)) Launcher *launcher = [[Launcher alloc] init];
        application.delegate = launcher;
        [application run];
    }
    return 0;
}
