using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Zapret Control")]
[assembly: AssemblyDescription("Desktop Controller for Zapret")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace ZapretControlHost
{
    internal static class Program
    {
        private static Mutex singleInstanceMutex;

        [STAThread]
        private static void Main(string[] args)
        {
            bool createdNew;
            singleInstanceMutex = new Mutex(true, "Local\\ZapretControlSingleInstanceMutex", out createdNew);
            if (!createdNew)
            {
                return;
            }

            bool startMinimized = false;
            foreach (string a in args)
            {
                if (string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(a, "--startup", StringComparison.OrdinalIgnoreCase))
                {
                    startMinimized = true;
                }
            }

            if (!IsAdministrator())
            {
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
            Application.Run(new TrayHostContext(startMinimized));
        }

        private static bool IsAdministrator()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                WindowsPrincipal principal = new WindowsPrincipal(identity);
                return principal.IsInRole(WindowsBuiltInRole.Administrator);
            }
        }
    }

    internal sealed class TrayHostContext : ApplicationContext
    {
        private readonly NotifyIcon trayIcon;
        private readonly string repoRoot;
        private readonly int port;
        private Process backendProcess;
        private Process powershellBackend;
        private Process uiAppProcess;

        public TrayHostContext(bool startMinimized)
        {
            repoRoot = ResolveRepoRoot();
            port = FindAvailablePort(3847);

            Icon icon = BuildShieldIcon();
            ContextMenuStrip menu = new ContextMenuStrip();

            ToolStripMenuItem openItem = new ToolStripMenuItem("Открыть окно Zapret Control");
            openItem.Font = new Font(openItem.Font, FontStyle.Bold);
            openItem.Click += (s, e) => OpenAppWindow();

            ToolStripMenuItem stopBypassItem = new ToolStripMenuItem("Остановить обход (winws.exe)");
            stopBypassItem.Click += (s, e) => PostApiSimple("/api/runner/stop");

            ToolStripMenuItem openFolderItem = new ToolStripMenuItem("Открыть папку zapret");
            openFolderItem.Click += (s, e) =>
            {
                string zDir = Path.Combine(repoRoot, "zapret");
                if (Directory.Exists(zDir))
                {
                    Process.Start("explorer.exe", "\"" + zDir + "\"");
                }
            };

            ToolStripMenuItem exitItem = new ToolStripMenuItem("Выход (остановить обход и закрыть)");
            exitItem.Click += (s, e) => ShutdownAll();

            menu.Items.Add(openItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(stopBypassItem);
            menu.Items.Add(openFolderItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            trayIcon = new NotifyIcon
            {
                Icon = icon,
                Text = "Zapret Control",
                ContextMenuStrip = menu,
                Visible = true
            };
            trayIcon.DoubleClick += (s, e) => OpenAppWindow();

            StartBackendServer();
            WaitForServerReady(port, 4500);

            if (!startMinimized)
            {
                OpenAppWindow();
            }
        }

        private string ResolveRepoRoot()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            if (Directory.Exists(Path.Combine(baseDir, "app", "static")))
            {
                return baseDir;
            }
            DirectoryInfo parent = Directory.GetParent(baseDir);
            if (parent != null && Directory.Exists(Path.Combine(parent.FullName, "app", "static")))
            {
                return parent.FullName;
            }
            return baseDir;
        }

        private static int FindAvailablePort(int preferred)
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
                TcpListener l = new TcpListener(IPAddress.Loopback, 0);
                l.Start();
                int assigned = ((IPEndPoint)l.LocalEndpoint).Port;
                l.Stop();
                return assigned;
            }
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

            // Fallback native PowerShell HTTP bridge when Node.js is not installed on Windows
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
            string url = "http://127.0.0.1:" + port;
            string browserExe = FindAppModeBrowser();
            if (!string.IsNullOrEmpty(browserExe))
            {
                string profileDir = Path.Combine(repoRoot, "app", "data", "window-profile");
                Directory.CreateDirectory(profileDir);
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = browserExe,
                    Arguments = "--app=" + url + " --window-size=1220,800 --user-data-dir=\"" + profileDir + "\" --no-first-run --disable-extensions",
                    UseShellExecute = false
                };
                uiAppProcess = Process.Start(psi);
            }
            else
            {
                Process.Start(url);
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

        private void PostApiSimple(string path)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
                req.Method = "POST";
                req.ContentType = "application/json";
                byte[] body = Encoding.UTF8.GetBytes("{}");
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

        private static Icon BuildShieldIcon()
        {
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush bg = new SolidBrush(Color.FromArgb(29, 52, 88)))
                {
                    g.FillEllipse(bg, 1, 1, 30, 30);
                }
                using (Pen pen = new Pen(Color.FromArgb(168, 199, 250), 2.4f))
                {
                    Point[] shield = new Point[]
                    {
                        new Point(16, 6),
                        new Point(24, 9),
                        new Point(23, 18),
                        new Point(16, 25),
                        new Point(9, 18),
                        new Point(8, 9)
                    };
                    g.DrawPolygon(pen, shield);
                }
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        private void ShutdownAll()
        {
            PostApiSimple("/api/runner/stop");
            trayIcon.Visible = false;

            try
            {
                if (backendProcess != null && !backendProcess.HasExited)
                {
                    backendProcess.Kill();
                }
            }
            catch
            {
            }

            try
            {
                if (powershellBackend != null && !powershellBackend.HasExited)
                {
                    powershellBackend.Kill();
                }
            }
            catch
            {
            }

            try
            {
                ProcessStartInfo tk = new ProcessStartInfo("taskkill.exe", "/IM winws.exe /F")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                Process.Start(tk);
            }
            catch
            {
            }

            Application.Exit();
        }
    }
}
