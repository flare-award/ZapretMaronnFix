using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Zapret Control")]
[assembly: AssemblyDescription("Desktop Controller for Zapret")]
[assembly: AssemblyVersion("1.2.0.0")]

namespace ZapretControlHost
{
    internal static class NativeWin32
    {
        public const int WM_CLOSE = 0x0010;
        public const int WM_SETICON = 0x0080;
        public const int ICON_SMALL = 0;
        public const int ICON_BIG = 1;
        public const int ICON_SMALL2 = 2;
        public const int SW_RESTORE = 9;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateRoundRectRgn(
            int nLeftRect,
            int nTopRect,
            int nRightRect,
            int nBottomRect,
            int nWidthEllipse,
            int nHeightEllipse
        );
    }

    internal sealed class TraySnapshot
    {
        public bool Running;
        public string StrategyLabel = "general";
    }

    internal static class Program
    {
        private static Mutex singleInstanceMutex;

        [STAThread]
        private static void Main(string[] args)
        {
            bool startMinimized = false;
            bool relaunchAfterUpdate = false;
            int preferredPort = 3847;

            foreach (string a in args)
            {
                if (string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "--startup", StringComparison.OrdinalIgnoreCase))
                {
                    startMinimized = true;
                }
                else if (string.Equals(a, "--relaunch-after-update", StringComparison.OrdinalIgnoreCase))
                {
                    relaunchAfterUpdate = true;
                }
                else if (a != null && a.StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
                {
                    int parsedPort;
                    if (int.TryParse(a.Substring(7), out parsedPort) && parsedPort > 0 && parsedPort < 65536)
                    {
                        preferredPort = parsedPort;
                    }
                }
            }

            bool createdNew = false;
            int mutexAttempts = relaunchAfterUpdate ? 30 : 1;
            for (int i = 0; i < mutexAttempts; i++)
            {
                singleInstanceMutex = new Mutex(true, "Local\\ZapretControlSingleInstanceMutex", out createdNew);
                if (createdNew) break;
                try
                {
                    singleInstanceMutex.Dispose();
                }
                catch
                {
                }
                singleInstanceMutex = null;
                if (i + 1 < mutexAttempts)
                {
                    Thread.Sleep(150);
                }
            }

            if (!createdNew)
            {
                FocusExistingWindow();
                return;
            }

            if (!IsAdministrator())
            {
                ReleaseSingleInstanceMutex();
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = Application.ExecutablePath,
                        Arguments = string.Join(" ", args),
                        Verb = "runas",
                        UseShellExecute = true,
                        WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory
                    };
                    Process.Start(psi);
                }
                catch
                {
                    MessageBox.Show(
                        "Для работы драйвера WinDivert и запуска winws.exe необходимы права Администратора.",
                        "Zapret Control",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayHostContext(startMinimized, preferredPort, relaunchAfterUpdate));
        }

        public static void ReleaseSingleInstanceMutex()
        {
            if (singleInstanceMutex != null)
            {
                try
                {
                    singleInstanceMutex.ReleaseMutex();
                }
                catch
                {
                }
                try
                {
                    singleInstanceMutex.Dispose();
                }
                catch
                {
                }
                singleInstanceMutex = null;
            }
        }

        private static bool IsAdministrator()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                WindowsPrincipal principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        public static IntPtr FindZapretControlWindow()
        {
            IntPtr found = IntPtr.Zero;
            NativeWin32.EnumWindows((hWnd, lParam) =>
            {
                if (!NativeWin32.IsWindowVisible(hWnd)) return true;
                StringBuilder sb = new StringBuilder(256);
                NativeWin32.GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString();
                if (!string.IsNullOrEmpty(title) &&
                    title.IndexOf("Zapret Control", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    found = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public static void CloseAllZapretControlWindows()
        {
            NativeWin32.EnumWindows((hWnd, lParam) =>
            {
                StringBuilder sb = new StringBuilder(256);
                NativeWin32.GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString();
                if (!string.IsNullOrEmpty(title) &&
                    title.IndexOf("Zapret Control", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    NativeWin32.PostMessage(hWnd, NativeWin32.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                }
                return true;
            }, IntPtr.Zero);
        }

        public static bool FocusExistingWindow()
        {
            IntPtr hWnd = FindZapretControlWindow();
            if (hWnd != IntPtr.Zero)
            {
                if (NativeWin32.IsIconic(hWnd))
                {
                    NativeWin32.ShowWindow(hWnd, NativeWin32.SW_RESTORE);
                }
                NativeWin32.SetForegroundWindow(hWnd);
                return true;
            }
            return false;
        }
    }

    internal sealed class TrayHostContext : ApplicationContext
    {
        private readonly NotifyIcon trayIcon;
        private readonly string repoRoot;
        private readonly int port;
        private readonly Icon smallIcon;
        private readonly Icon largeIcon;
        private Process backendProcess;
        private Process powershellBackend;
        private Process uiAppProcess;
        private DarkTrayMenuForm activeMenu;
        private System.Windows.Forms.Timer iconSyncTimer;
        private bool windowObservedOpen;
        private bool isShuttingDown;

        public TrayHostContext(bool startMinimized, int preferredPort, bool waitForPreferredPort)
        {
            repoRoot = ResolveRepoRoot();
            port = FindAvailablePort(preferredPort, waitForPreferredPort);

            LoadBrandIcons(repoRoot, out smallIcon, out largeIcon);

            trayIcon = new NotifyIcon
            {
                Icon = smallIcon,
                Text = "Zapret Control",
                Visible = true
            };
            trayIcon.MouseUp += OnTrayMouseUp;
            trayIcon.DoubleClick += (s, e) => OpenAppWindow();

            StartBackendServer();
            WaitForServerReady(port, 4800);

            iconSyncTimer = new System.Windows.Forms.Timer();
            iconSyncTimer.Interval = 1000;
            iconSyncTimer.Tick += OnWatchdogTick;
            iconSyncTimer.Start();

            if (!startMinimized)
            {
                OpenAppWindow();
            }
        }

        private void OnWatchdogTick(object sender, EventArgs e)
        {
            if (isShuttingDown) return;
            IntPtr hWnd = Program.FindZapretControlWindow();
            if (hWnd != IntPtr.Zero)
            {
                windowObservedOpen = true;
                ApplyWindowIcons();
            }
            else if (windowObservedOpen)
            {
                windowObservedOpen = false;
                if (!ReadMinimizeToTrayOnClose())
                {
                    ShutdownAll();
                }
            }
        }

        private bool ReadMinimizeToTrayOnClose()
        {
            try
            {
                string settingsPath = Path.Combine(repoRoot, "app", "data", "settings.json");
                if (File.Exists(settingsPath))
                {
                    string raw = File.ReadAllText(settingsPath, Encoding.UTF8);
                    Match m = Regex.Match(raw, "\"minimizeToTrayOnClose\"\\s*:\\s*(true|false)", RegexOptions.IgnoreCase);
                    if (m.Success)
                    {
                        return string.Equals(m.Groups[1].Value, "true", StringComparison.OrdinalIgnoreCase);
                    }
                }
            }
            catch
            {
            }
            return true;
        }

        private void OnTrayMouseUp(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right && !isShuttingDown)
            {
                ShowCustomTrayMenu(Cursor.Position);
            }
        }

        private void ShowCustomTrayMenu(Point anchorScreenPos)
        {
            if (activeMenu != null && !activeMenu.IsDisposed)
            {
                activeMenu.Close();
                activeMenu.Dispose();
                activeMenu = null;
            }

            TraySnapshot snap = FetchTraySnapshot();
            activeMenu = new DarkTrayMenuForm(
                snap,
                smallIcon,
                onOpenWindow: () => OpenAppWindow(),
                onToggleBypass: () =>
                {
                    if (snap.Running)
                    {
                        PostApiJson("/api/runner/stop", "{}", 1500);
                    }
                    else
                    {
                        PostApiJson("/api/runner/start", "{}", 1500);
                    }
                },
                onOpenZapretFolder: () =>
                {
                    string zDir = Path.Combine(repoRoot, "zapret");
                    if (Directory.Exists(zDir))
                    {
                        Process.Start("explorer.exe", "\"" + zDir + "\"");
                    }
                },
                onExitApp: () => ShutdownAll()
            );

            activeMenu.ShowAtCursor(anchorScreenPos);
        }

        private TraySnapshot FetchTraySnapshot()
        {
            TraySnapshot snap = new TraySnapshot();
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/state");
                req.Timeout = 300;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (Stream st = resp.GetResponseStream())
                using (StreamReader sr = new StreamReader(st, Encoding.UTF8))
                {
                    string json = sr.ReadToEnd();

                    Match runMatch = Regex.Match(json, "\"runtime\"\\s*:\\s*\\{[^}]*\"running\"\\s*:\\s*(true|false)", RegexOptions.IgnoreCase);
                    if (runMatch.Success)
                    {
                        snap.Running = string.Equals(runMatch.Groups[1].Value, "true", StringComparison.OrdinalIgnoreCase);
                    }

                    Match activeStrat = Regex.Match(json, "\"activeStrategy\"\\s*:\\s*\"([^\"]+)\"");
                    Match selStrat = Regex.Match(json, "\"selectedStrategy\"\\s*:\\s*\"([^\"]+)\"");
                    string strat = activeStrat.Success && !string.IsNullOrEmpty(activeStrat.Groups[1].Value)
                        ? UnescapeJsonString(activeStrat.Groups[1].Value)
                        : (selStrat.Success ? UnescapeJsonString(selStrat.Groups[1].Value) : null);
                    if (!string.IsNullOrEmpty(strat))
                    {
                        if (strat.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
                        {
                            strat = strat.Substring(0, strat.Length - 4);
                        }
                        snap.StrategyLabel = strat;
                    }
                    return snap;
                }
            }
            catch
            {
            }

            try
            {
                string settingsPath = Path.Combine(repoRoot, "app", "data", "settings.json");
                if (File.Exists(settingsPath))
                {
                    string rawSettings = File.ReadAllText(settingsPath, Encoding.UTF8);
                    Match selStrat = Regex.Match(rawSettings, "\"selectedStrategy\"\\s*:\\s*\"([^\"]+)\"");
                    if (selStrat.Success && !string.IsNullOrEmpty(selStrat.Groups[1].Value))
                    {
                        string strat = UnescapeJsonString(selStrat.Groups[1].Value);
                        if (strat.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
                        {
                            strat = strat.Substring(0, strat.Length - 4);
                        }
                        snap.StrategyLabel = strat;
                    }
                }
            }
            catch
            {
            }
            return snap;
        }

        private static string UnescapeJsonString(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return string.Empty;
            return Regex.Replace(raw, "\\\\u([0-9a-fA-F]{4})", m =>
            {
                int code = Convert.ToInt32(m.Groups[1].Value, 16);
                return ((char)code).ToString();
            }).Replace("\\\"", "\"").Replace("\\\\", "\\");
        }

        private string ResolveRepoRoot()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            if (Directory.Exists(Path.Combine(baseDir, "app", "static")) ||
                Directory.Exists(Path.Combine(baseDir, "app", "server")))
            {
                return baseDir;
            }
            DirectoryInfo parent = Directory.GetParent(baseDir);
            if (parent != null && Directory.Exists(Path.Combine(parent.FullName, "app")))
            {
                return parent.FullName;
            }
            return baseDir;
        }

        private static int FindAvailablePort(int preferred, bool waitIfBusy)
        {
            int attempts = waitIfBusy ? 30 : 1;
            for (int i = 0; i < attempts; i++)
            {
                try
                {
                    TcpListener l = new TcpListener(IPAddress.Loopback, preferred);
                    l.Start();
                    l.Stop();
                    return preferred;
                }
                catch
                {
                    if (i + 1 < attempts)
                    {
                        Thread.Sleep(120);
                    }
                }
            }

            TcpListener fallback = new TcpListener(IPAddress.Loopback, 0);
            fallback.Start();
            int assigned = ((IPEndPoint)fallback.LocalEndpoint).Port;
            fallback.Stop();
            return assigned;
        }

        private void StartBackendServer()
        {
            string nodeExe = FindExecutableInPath("node.exe");
            string serverMjs = Path.Combine(repoRoot, "app", "server", "index.mjs");
            if (!string.IsNullOrEmpty(nodeExe) && File.Exists(serverMjs))
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    Arguments = "\"" + serverMjs + "\"",
                    WorkingDirectory = repoRoot,
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                psi.EnvironmentVariables["HOST"] = "127.0.0.1";
                psi.EnvironmentVariables["PORT"] = port.ToString();
                backendProcess = Process.Start(psi);
                return;
            }

            string psServer = Path.Combine(repoRoot, "app", "host", "NativeServer.ps1");
            if (File.Exists(psServer))
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + psServer + "\" -Port " + port + " -RepoRoot \"" + repoRoot + "\"",
                    WorkingDirectory = repoRoot,
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                powershellBackend = Process.Start(psi);
            }
        }

        private static string FindExecutableInPath(string exeName)
        {
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (string dir in pathEnv.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim(), exeName);
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                }
            }
            string pfNode = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", exeName);
            if (File.Exists(pfNode)) return pfNode;
            return null;
        }

        private static void WaitForServerReady(int port, int timeoutMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            string url = "http://127.0.0.1:" + port + "/api/state";
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                    req.Timeout = 400;
                    using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                    {
                        if ((int)resp.StatusCode == 200) return;
                    }
                }
                catch
                {
                    Thread.Sleep(120);
                }
            }
        }

        private void OpenAppWindow()
        {
            if (Program.FocusExistingWindow())
            {
                ApplyWindowIcons();
                return;
            }

            string url = "http://127.0.0.1:" + port;
            string browserExe = FindAppModeBrowser();
            if (!string.IsNullOrEmpty(browserExe))
            {
                string profileDir = Path.Combine(repoRoot, "app", "data", "ui-window-v2");
                Directory.CreateDirectory(profileDir);

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = browserExe,
                    Arguments = "--app=" + url + " --window-size=1260,820 --user-data-dir=\"" + profileDir + "\" --no-first-run --disable-extensions",
                    UseShellExecute = false
                };
                uiAppProcess = Process.Start(psi);

                ThreadPool.QueueUserWorkItem(_ =>
                {
                    for (int attempt = 0; attempt < 25; attempt++)
                    {
                        Thread.Sleep(180);
                        if (ApplyWindowIcons())
                        {
                            Thread.Sleep(400);
                            ApplyWindowIcons();
                            break;
                        }
                    }
                });
            }
            else
            {
                Process.Start(url);
            }
        }

        private bool ApplyWindowIcons()
        {
            IntPtr hWnd = Program.FindZapretControlWindow();
            if (hWnd == IntPtr.Zero) return false;
            try
            {
                if (smallIcon != null)
                {
                    NativeWin32.SendMessage(hWnd, NativeWin32.WM_SETICON, (IntPtr)NativeWin32.ICON_SMALL, smallIcon.Handle);
                    NativeWin32.SendMessage(hWnd, NativeWin32.WM_SETICON, (IntPtr)NativeWin32.ICON_SMALL2, smallIcon.Handle);
                }
                if (largeIcon != null)
                {
                    NativeWin32.SendMessage(hWnd, NativeWin32.WM_SETICON, (IntPtr)NativeWin32.ICON_BIG, largeIcon.Handle);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string FindAppModeBrowser()
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft\\Edge\\Application\\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft\\Edge\\Application\\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google\\Chrome\\Application\\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google\\Chrome\\Application\\chrome.exe")
            };
            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }

        private void PostApiJson(string path, string jsonPayload, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
                req.Method = "POST";
                req.Timeout = timeoutMs;
                req.ContentType = "application/json";
                byte[] body = Encoding.UTF8.GetBytes(jsonPayload ?? "{}");
                req.ContentLength = body.Length;
                using (Stream st = req.GetRequestStream())
                {
                    st.Write(body, 0, body.Length);
                }
                using (WebResponse resp = req.GetResponse())
                {
                }
            }
            catch
            {
            }
        }

        private static void RunSilentProcess(string exe, string arguments, int waitMs)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(exe, arguments)
                {
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                using (Process p = Process.Start(psi))
                {
                    if (p != null && waitMs > 0)
                    {
                        p.WaitForExit(waitMs);
                    }
                }
            }
            catch
            {
            }
        }

        private static void LoadBrandIcons(string repoRoot, out Icon small, out Icon large)
        {
            string icoPath = Path.Combine(repoRoot, "app", "host", "app.ico");
            if (!File.Exists(icoPath))
            {
                icoPath = Path.Combine(repoRoot, "app", "static", "favicon.ico");
            }
            if (File.Exists(icoPath))
            {
                try
                {
                    small = new Icon(icoPath, new Size(16, 16));
                    large = new Icon(icoPath, new Size(48, 48));
                    return;
                }
                catch
                {
                }
            }

            try
            {
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null)
                {
                    small = exeIcon;
                    large = exeIcon;
                    return;
                }
            }
            catch
            {
            }

            Icon fallback = BuildFallbackShieldIcon(32);
            small = fallback;
            large = BuildFallbackShieldIcon(48);
        }

        private static Icon BuildFallbackShieldIcon(int size)
        {
            Bitmap bmp = new Bitmap(size, size);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                int pad = Math.Max(1, size / 16);
                using (SolidBrush bg = new SolidBrush(Color.FromArgb(29, 52, 88)))
                {
                    g.FillEllipse(bg, pad, pad, size - pad * 2, size - pad * 2);
                }
                using (Pen pen = new Pen(Color.FromArgb(168, 199, 250), Math.Max(1.8f, size * 0.075f)))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    PointF[] shield = new PointF[]
                    {
                        new PointF(size * 0.50f, size * 0.19f),
                        new PointF(size * 0.75f, size * 0.28f),
                        new PointF(size * 0.72f, size * 0.56f),
                        new PointF(size * 0.50f, size * 0.78f),
                        new PointF(size * 0.28f, size * 0.56f),
                        new PointF(size * 0.25f, size * 0.28f)
                    };
                    g.DrawPolygon(pen, shield);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        private void ShutdownAll()
        {
            if (isShuttingDown) return;
            isShuttingDown = true;

            try
            {
                if (activeMenu != null && !activeMenu.IsDisposed)
                {
                    activeMenu.Close();
                    activeMenu.Dispose();
                    activeMenu = null;
                }
            }
            catch
            {
            }

            try
            {
                if (iconSyncTimer != null)
                {
                    iconSyncTimer.Stop();
                    iconSyncTimer.Dispose();
                }
            }
            catch
            {
            }

            try
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
            }
            catch
            {
            }

            // 1. Close dedicated --app UI window immediately
            Program.CloseAllZapretControlWindows();
            try
            {
                if (uiAppProcess != null && !uiAppProcess.HasExited)
                {
                    RunSilentProcess("taskkill.exe", "/PID " + uiAppProcess.Id + " /T /F", 600);
                }
            }
            catch
            {
            }

            // Also terminate any detached Chromium/Edge process holding our isolated ui-window-v2 profile
            RunSilentProcess(
                "powershell.exe",
                "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*ui-window-v2*' -or $_.CommandLine -like '*window-profile*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"",
                900
            );

            // 2. Request graceful backend shutdown + stop bypass services
            PostApiJson("/api/system/shutdown", "{}", 650);

            // 3. Terminate backend server process tree
            try
            {
                if (backendProcess != null && !backendProcess.HasExited)
                {
                    RunSilentProcess("taskkill.exe", "/PID " + backendProcess.Id + " /T /F", 700);
                }
            }
            catch
            {
            }

            try
            {
                if (powershellBackend != null && !powershellBackend.HasExited)
                {
                    RunSilentProcess("taskkill.exe", "/PID " + powershellBackend.Id + " /T /F", 700);
                }
            }
            catch
            {
            }

            // 4. Stop zapret & GoodbyeDPI services, terminate winws/goodbyedpi, and unload WinDivert kernel driver
            StopBypassServicesAndUnloadWinDivert();

            Program.ReleaseSingleInstanceMutex();
            Application.ExitThread();
            Environment.Exit(0);
        }

        private static void StopBypassServicesAndUnloadWinDivert()
        {
            string[] bypassServices = new string[] { "zapret", "GoodbyeDPI", "discordfix_zapret", "winws1", "winws2" };
            foreach (string svc in bypassServices)
            {
                RunSilentProcess("sc.exe", "stop \"" + svc + "\"", 800);
            }

            RunSilentProcess("taskkill.exe", "/IM winws.exe /F", 600);
            RunSilentProcess("taskkill.exe", "/IM goodbyedpi.exe /F", 600);

            Thread.Sleep(220);

            string[] driverServices = new string[] { "WinDivert", "WinDivert14", "WinDivert64" };
            foreach (string drv in driverServices)
            {
                RunSilentProcess("sc.exe", "stop \"" + drv + "\"", 700);
                RunSilentProcess("sc.exe", "delete \"" + drv + "\"", 700);
            }
        }
    }

    // Custom borderless dark popup menu with anti-aliased Lucide vector icons
    internal sealed class DarkTrayMenuForm : Form
    {
        private enum IconKind
        {
            Window,
            Power,
            Folder,
            Exit
        }

        private sealed class MenuEntry
        {
            public bool IsSeparator;
            public string Label;
            public IconKind Icon;
            public Color? AccentColor;
            public Action OnClick;
            public Rectangle Bounds;
        }

        private readonly TraySnapshot snapshot;
        private readonly Icon brandIcon;
        private readonly List<MenuEntry> entries = new List<MenuEntry>();
        private int hoveredIndex = -1;
        private bool isExecutingAction;

        private static readonly Color BgSurface = Color.FromArgb(23, 27, 36);        // #171B24
        private static readonly Color BgHeader = Color.FromArgb(17, 20, 27);         // #11141B
        private static readonly Color HoverFill = Color.FromArgb(29, 52, 88);        // #1D3458
        private static readonly Color HoverDangerFill = Color.FromArgb(63, 28, 32);
        private static readonly Color BorderCol = Color.FromArgb(42, 49, 64);        // #2A3140
        private static readonly Color DividerCol = Color.FromArgb(37, 43, 56);       // #252B38
        private static readonly Color TextPrimary = Color.FromArgb(227, 231, 239);   // #E3E7EF
        private static readonly Color TextSecondary = Color.FromArgb(149, 159, 177); // #959FB1
        private static readonly Color TextMuted = Color.FromArgb(105, 115, 134);     // #697386
        private static readonly Color AccentBlue = Color.FromArgb(168, 199, 250);    // #A8C7FA
        private static readonly Color AccentGreen = Color.FromArgb(125, 216, 166);   // #7DD8A6
        private static readonly Color AccentCoral = Color.FromArgb(242, 184, 181);   // #F2B8B5

        private const int MenuWidth = 264;
        private const int HeaderHeight = 38;
        private const int ItemHeight = 36;
        private const int SeparatorHeight = 11;

        public DarkTrayMenuForm(
            TraySnapshot snap,
            Icon icon,
            Action onOpenWindow,
            Action onToggleBypass,
            Action onOpenZapretFolder,
            Action onExitApp)
        {
            snapshot = snap;
            brandIcon = icon;

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            DoubleBuffered = true;
            BackColor = BgSurface;
            Font = new Font("Segoe UI", 9.25f, FontStyle.Regular, GraphicsUnit.Point);

            BuildEntries(onOpenWindow, onToggleBypass, onOpenZapretFolder, onExitApp);
            LayoutEntries();

            Region = Region.FromHrgn(NativeWin32.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, 16, 16));

            Deactivate += (s, e) =>
            {
                if (!isExecutingAction)
                {
                    SafeDismiss();
                }
            };
            KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Escape) SafeDismiss();
            };
        }

        protected override bool ShowWithoutActivation
        {
            get { return false; }
        }

        private void BuildEntries(
            Action onOpenWindow,
            Action onToggleBypass,
            Action onOpenZapretFolder,
            Action onExitApp)
        {
            entries.Add(new MenuEntry
            {
                Label = "Открыть Zapret Control",
                Icon = IconKind.Window,
                OnClick = onOpenWindow
            });

            entries.Add(new MenuEntry
            {
                Label = snapshot.Running ? "Остановить обход" : "Включить обход",
                Icon = IconKind.Power,
                AccentColor = snapshot.Running ? AccentCoral : AccentGreen,
                OnClick = onToggleBypass
            });

            entries.Add(new MenuEntry { IsSeparator = true });

            entries.Add(new MenuEntry
            {
                Label = "Открыть папку zapret",
                Icon = IconKind.Folder,
                OnClick = onOpenZapretFolder
            });

            entries.Add(new MenuEntry { IsSeparator = true });

            entries.Add(new MenuEntry
            {
                Label = "Выход из программы",
                Icon = IconKind.Exit,
                AccentColor = AccentCoral,
                OnClick = onExitApp
            });
        }

        private void LayoutEntries()
        {
            int y = HeaderHeight + 6;
            foreach (MenuEntry e in entries)
            {
                if (e.IsSeparator)
                {
                    e.Bounds = new Rectangle(12, y, MenuWidth - 24, SeparatorHeight);
                    y += SeparatorHeight;
                }
                else
                {
                    e.Bounds = new Rectangle(7, y, MenuWidth - 14, ItemHeight);
                    y += ItemHeight + 2;
                }
            }
            Width = MenuWidth;
            Height = y + 7;
        }

        public void ShowAtCursor(Point cursor)
        {
            Rectangle work = Screen.FromPoint(cursor).WorkingArea;
            int x = cursor.X - Width + 14;
            int y = cursor.Y - Height - 8;

            if (x < work.Left + 8) x = work.Left + 8;
            if (x + Width > work.Right - 8) x = work.Right - Width - 8;
            if (y < work.Top + 8) y = cursor.Y + 8;
            if (y + Height > work.Bottom - 8) y = work.Bottom - Height - 8;

            Location = new Point(x, y);
            Show();
            Activate();
        }

        private void SafeDismiss()
        {
            if (!IsDisposed)
            {
                Close();
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int found = -1;
            for (int i = 0; i < entries.Count; i++)
            {
                MenuEntry item = entries[i];
                if (!item.IsSeparator && item.Bounds.Contains(e.Location))
                {
                    found = i;
                    break;
                }
            }
            if (found != hoveredIndex)
            {
                hoveredIndex = found;
                Cursor = found >= 0 ? Cursors.Hand : Cursors.Default;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hoveredIndex != -1)
            {
                hoveredIndex = -1;
                Cursor = Cursors.Default;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left || isExecutingAction) return;
            for (int i = 0; i < entries.Count; i++)
            {
                MenuEntry item = entries[i];
                if (!item.IsSeparator && item.Bounds.Contains(e.Location))
                {
                    isExecutingAction = true;
                    Action act = item.OnClick;
                    SafeDismiss();
                    if (act != null)
                    {
                        act();
                    }
                    return;
                }
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            // Header surface showing only current strategy name
            using (SolidBrush hb = new SolidBrush(BgHeader))
            {
                g.FillRectangle(hb, 0, 0, Width, HeaderHeight);
            }
            using (Pen divPen = new Pen(DividerCol, 1f))
            {
                g.DrawLine(divPen, 0, HeaderHeight, Width, HeaderHeight);
            }

            string strategyTitle = string.IsNullOrEmpty(snapshot.StrategyLabel) ? "general" : snapshot.StrategyLabel;
            using (Font stratFont = new Font("Segoe UI Semibold", 9.15f, FontStyle.Bold))
            using (SolidBrush stratBrush = new SolidBrush(TextPrimary))
            {
                RectangleF headerRect = new RectangleF(18f, 0f, Width - 32f, HeaderHeight);
                StringFormat sf = new StringFormat
                {
                    LineAlignment = StringAlignment.Center,
                    Trimming = StringTrimming.EllipsisCharacter,
                    FormatFlags = StringFormatFlags.NoWrap
                };
                g.DrawString(strategyTitle, stratFont, stratBrush, headerRect, sf);
            }

            // Menu items
            for (int i = 0; i < entries.Count; i++)
            {
                MenuEntry item = entries[i];
                if (item.IsSeparator)
                {
                    int midY = item.Bounds.Top + item.Bounds.Height / 2;
                    using (Pen p = new Pen(DividerCol, 1f))
                    {
                        g.DrawLine(p, item.Bounds.Left, midY, item.Bounds.Right, midY);
                    }
                    continue;
                }

                bool hovered = (i == hoveredIndex);
                if (hovered)
                {
                    Color fill = item.Icon == IconKind.Exit ? HoverDangerFill : HoverFill;
                    using (GraphicsPath pill = RoundedRect(item.Bounds, 9))
                    using (SolidBrush hb = new SolidBrush(fill))
                    {
                        g.FillPath(hb, pill);
                    }
                }

                Color fg = item.AccentColor.HasValue
                    ? item.AccentColor.Value
                    : (hovered ? TextPrimary : Color.FromArgb(208, 214, 226));
                Color iconCol = item.AccentColor.HasValue
                    ? item.AccentColor.Value
                    : (hovered ? AccentBlue : TextSecondary);

                RectangleF iconBox = new RectangleF(item.Bounds.Left + 11f, item.Bounds.Top + 10f, 16f, 16f);
                DrawLucideIcon(g, item.Icon, iconBox, iconCol);

                RectangleF textBox = new RectangleF(
                    item.Bounds.Left + 36f,
                    item.Bounds.Top,
                    item.Bounds.Width - 44f,
                    item.Bounds.Height
                );
                using (SolidBrush tb = new SolidBrush(fg))
                using (Font itemFont = new Font("Segoe UI", 9.15f, FontStyle.Regular))
                {
                    StringFormat sf = new StringFormat
                    {
                        LineAlignment = StringAlignment.Center,
                        Trimming = StringTrimming.EllipsisCharacter,
                        FormatFlags = StringFormatFlags.NoWrap
                    };
                    g.DrawString(item.Label, itemFont, tb, textBox, sf);
                }
            }

            // Outer rounded border
            using (GraphicsPath outer = RoundedRect(new Rectangle(0, 0, Width - 1, Height - 1), 15))
            using (Pen borderPen = new Pen(BorderCol, 1f))
            {
                g.DrawPath(borderPen, outer);
            }
        }

        private static void DrawLucideIcon(Graphics g, IconKind kind, RectangleF r, Color color)
        {
            using (Pen p = CreateLucidePen(color, 1.7f))
            {
                switch (kind)
                {
                    case IconKind.Window:
                    {
                        using (GraphicsPath box = RoundedRectF(r, 3.2f))
                        {
                            g.DrawPath(p, box);
                        }
                        float barY = r.Top + r.Height * 0.34f;
                        g.DrawLine(p, r.Left + 1f, barY, r.Right - 1f, barY);
                        break;
                    }
                    case IconKind.Power:
                    {
                        RectangleF arcRect = new RectangleF(r.Left + 1.5f, r.Top + 2.2f, r.Width - 3f, r.Height - 3f);
                        g.DrawArc(p, arcRect, -52f, 284f);
                        float cx = r.Left + r.Width * 0.5f;
                        g.DrawLine(p, cx, r.Top + 0.8f, cx, r.Top + r.Height * 0.48f);
                        break;
                    }
                    case IconKind.Folder:
                    {
                        PointF[] pts = new PointF[]
                        {
                            new PointF(r.Left + 1f, r.Top + r.Height * 0.24f),
                            new PointF(r.Left + r.Width * 0.40f, r.Top + r.Height * 0.24f),
                            new PointF(r.Left + r.Width * 0.52f, r.Top + r.Height * 0.38f),
                            new PointF(r.Right - 1f, r.Top + r.Height * 0.38f),
                            new PointF(r.Right - 1f, r.Bottom - 1.5f),
                            new PointF(r.Left + 1f, r.Bottom - 1.5f)
                        };
                        g.DrawPolygon(p, pts);
                        break;
                    }
                    case IconKind.Exit:
                    {
                        PointF[] door = new PointF[]
                        {
                            new PointF(r.Left + r.Width * 0.45f, r.Top + 1.5f),
                            new PointF(r.Left + 1.5f, r.Top + 1.5f),
                            new PointF(r.Left + 1.5f, r.Bottom - 1.5f),
                            new PointF(r.Left + r.Width * 0.45f, r.Bottom - 1.5f)
                        };
                        g.DrawLines(p, door);
                        float midY = r.Top + r.Height * 0.50f;
                        g.DrawLine(p, r.Left + r.Width * 0.36f, midY, r.Right - 1.2f, midY);
                        g.DrawLine(p, r.Right - 4.5f, midY - 3.3f, r.Right - 1.2f, midY);
                        g.DrawLine(p, r.Right - 4.5f, midY + 3.3f, r.Right - 1.2f, midY);
                        break;
                    }
                }
            }
        }

        private static Pen CreateLucidePen(Color color, float width)
        {
            return new Pen(color, width)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round,
                LineJoin = LineJoin.Round
            };
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            int d = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static GraphicsPath RoundedRectF(RectangleF bounds, float radius)
        {
            float d = radius * 2f;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
