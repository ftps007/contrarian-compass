// Native macOS shell for the metadata editor.
//
// A real application: own window, own Dock icon, own menu bar, cmd+Q. The user
// interface is the same page as everywhere else, shown in a WKWebView rather
// than in a browser, so there is still only one implementation of the cleaning
// logic.
//
// Two things a web view cannot do on its own and that are wired up here:
//   * the file picker — WKWebView shows nothing for <input type="file"> unless
//     the host application opens the panel,
//   * saving — the page hands the finished bytes to `speichern`, and the app
//     writes them through a normal save dialog.
//
// Built by standalone/build-app.sh with swiftc on the user's machine. Only
// long-standing AppKit and WebKit API is used, no third-party code.

import Cocoa
import WebKit

// ---------------------------------------------------------------------------
// Log — the installer's self-test reads this to confirm the app really started
// ---------------------------------------------------------------------------

func protokolliere(_ message: String) {
    let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs", isDirectory: true)
    let file = directory.appendingPathComponent("Metadaten-Editor.log")
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let stamp = DateFormatter()
    stamp.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let line = "\(stamp.string(from: Date())) \(message)\n"
    guard let data = line.data(using: .utf8) else { return }

    if let handle = try? FileHandle(forWritingTo: file) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: file)
    }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler
{
    private var window: NSWindow!
    private var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "speichern")

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 900), configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Metadaten-Editor"
        window.contentView = webView
        window.setFrameAutosaveName("MetadatenEditorFenster")
        window.minSize = NSSize(width: 720, height: 560)
        window.center()
        window.makeKeyAndOrderFront(nil)

        guard let resources = Bundle.main.resourceURL else {
            fail("Das Programmpaket enthält keinen Ressourcenordner.")
            return
        }
        let page = resources.appendingPathComponent("Metadaten-Editor.html")
        guard FileManager.default.fileExists(atPath: page.path) else {
            fail("Die Seite fehlt im Programmpaket: \(page.path)")
            return
        }

        protokolliere("Start (nativ, Seite: \(page.path))")
        webView.loadFileURL(page, allowingReadAccessTo: resources)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func fail(_ message: String) {
        protokolliere("FEHLER: \(message)")
        let alert = NSAlert()
        alert.messageText = "Metadaten-Editor"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

    // --- Page loading ------------------------------------------------------

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        protokolliere("OK: Oberfläche geladen")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("Die Oberfläche konnte nicht geladen werden: \(error.localizedDescription)")
    }

    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
    ) {
        fail("Die Oberfläche konnte nicht geladen werden: \(error.localizedDescription)")
    }

    // --- File picker -------------------------------------------------------

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.message = "Dateien oder Ordner zum Prüfen auswählen"
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // --- Saving ------------------------------------------------------------

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard message.name == "speichern",
            let body = message.body as? [String: Any],
            let name = body["name"] as? String,
            let encoded = body["daten"] as? String,
            let data = Data(base64Encoded: encoded)
        else {
            protokolliere("FEHLER: Speicheranfrage war unvollständig")
            return
        }

        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.message = "Bereinigte Datei sichern"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else {
                protokolliere("Speichern abgebrochen: \(name)")
                return
            }
            do {
                try data.write(to: url)
                protokolliere("Gesichert: \(url.path) (\(data.count) Bytes)")
            } catch {
                protokolliere("FEHLER beim Sichern: \(error.localizedDescription)")
                let alert = NSAlert()
                alert.messageText = "Sichern fehlgeschlagen"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
        }
    }

}

// ---------------------------------------------------------------------------
// Menu — without one there is no cmd+Q, and no copy and paste in text fields
// ---------------------------------------------------------------------------

func buildMenu() -> NSMenu {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Über Metadaten-Editor", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Metadaten-Editor ausblenden", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(NSMenuItem.separator())
    appMenu.addItem(withTitle: "Metadaten-Editor beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Bearbeiten")
    editMenu.addItem(withTitle: "Widerrufen", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "Wiederholen", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "Ausschneiden", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Kopieren", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Einsetzen", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Alles auswählen", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = editMenu
    main.addItem(editItem)

    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "Fenster")
    windowMenu.addItem(withTitle: "Im Dock ablegen", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Schließen", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)

    return main
}

// ---------------------------------------------------------------------------

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.mainMenu = buildMenu()
application.run()
