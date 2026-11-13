import SwiftUI
import UIKit
import ImageIO
import PhotosUI
import UniformTypeIdentifiers

/// Uses the Android AuthFlowView's 873 × 1920 reference coordinates and colors.
struct LoginView: UIViewControllerRepresentable {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var appLock: AppLockManager
    var addingAccount = false
    var onAuthenticated: (() -> Void)? = nil
    func makeUIViewController(context: Context) -> IOSAuthFlowController { IOSAuthFlowController(session: session, appLock: appLock, addingAccount: addingAccount, onAuthenticated: onAuthenticated) }
    func updateUIViewController(_ controller: IOSAuthFlowController, context: Context) {}
    static func dismantleUIViewController(_ controller: IOSAuthFlowController, coordinator: ()) { controller.stopRequests() }
}

final class IOSAuthFlowController: UIViewController, UITextFieldDelegate, PHPickerViewControllerDelegate {
    private enum Page: Equatable { case login, register }
    private struct Placement { let view: UIView; let rect: CGRect; let fontSize: CGFloat? }
    private let session: AppSession
    private let appLock: AppLockManager
    private let addingAccount: Bool
    private let ownerToken: String?
    private let onAuthenticated: (() -> Void)?
    private let backAnchor = PulseSwipeBackAnchorView()
    private let scroll = UIScrollView()
    private let sheet = UIView()
    private let gradient = CAGradientLayer()
    private var placements: [Placement] = []
    private var page = Page.login
    private var accountDraft = "", passwordDraft = "", nicknameDraft = ""
    private var passwordVisible = false, busy = false, active = false, captchaLoading = false
    private var rememberPassword = true
    private var rememberButton: UIButton?
    private var autofilled: RememberedLoginSecret?
    private var rememberedServer = APIClient.shared.serverIdentity
    private var rememberedReadError = ""
    private var accountInput: UITextField?, passwordInput: UITextField?, nicknameInput: UITextField?, captchaInput: UITextField?
    private var errorLabel: UILabel?, captchaStatus: UILabel?, eye: AuthReferenceIcon?
    private var primary: UIButton?, captchaButton: UIButton?, captchaImage: UIImageView?, refreshButton: UIButton?
    private var controls: [UIControl] = []
    private var avatarData: Data?
    private var avatarButton: UIButton?
    private var avatarStatus: UILabel?
    private var avatarLoading = false
    private var avatarGeneration = UUID()
    private var avatarTask: Task<Void, Never>?

    private var captchaState = RegistrationCaptchaState()
    private var challengeClient: APIClient?
    private var challengeTask: Task<Void, Never>?, submitTask: Task<Void, Never>?, expiryTask: Task<Void, Never>?
    private let profileBackground = UIColor(red: 248/255, green: 247/255, blue: 1, alpha: 1)
    private let fieldBackground = UIColor(red: 244/255, green: 242/255, blue: 250/255, alpha: 1)
    private let iconBlue = UIColor(red: 0, green: 28/255, blue: 150/255, alpha: 1)
    private let buttonBlue = UIColor(red: 0, green: 37/255, blue: 223/255, alpha: 1)
    private var uptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

    init(session: AppSession, appLock: AppLockManager, addingAccount: Bool = false, onAuthenticated: (() -> Void)? = nil) {
        self.session = session; self.appLock = appLock; self.addingAccount = addingAccount
        self.ownerToken = session.token; self.onAuthenticated = onAuthenticated
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use init(session:)") }
    override var prefersStatusBarHidden: Bool { !addingAccount }
    override var preferredStatusBarStyle: UIStatusBarStyle { addingAccount || page == .register ? .darkContent : .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        backAnchor.frame = view.bounds
        backAnchor.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        backAnchor.backAction = { [weak self] in self?.swipeBack() }
        view.addSubview(backAnchor)
        overrideUserInterfaceStyle = .light
        view.layer.insertSublayer(gradient, at: 0)
        gradient.colors = [UIColor(red: 173/255, green: 222/255, blue: 1, alpha: 1).cgColor,
                           UIColor(red: 112/255, green: 175/255, blue: 249/255, alpha: 1).cgColor,
                           UIColor(red: 40/255, green: 123/255, blue: 240/255, alpha: 1).cgColor]
        gradient.startPoint = CGPoint(x: 0, y: 0); gradient.endPoint = CGPoint(x: 1, y: 1)
        scroll.contentInsetAdjustmentBehavior = .never; scroll.showsVerticalScrollIndicator = false
        scroll.keyboardDismissMode = .onDrag; scroll.addSubview(sheet); view.addSubview(scroll)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        loadRememberedDefault()
        render()
        if !rememberedReadError.isEmpty { showError(rememberedReadError) }
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); active = true; syncControls()
        if page == .register && !busy { refreshCaptcha() }
    }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); stopRequests() }
    deinit { NotificationCenter.default.removeObserver(self); challengeTask?.cancel(); submitTask?.cancel(); expiryTask?.cancel() }
    func stopRequests() {
        active = false; challengeTask?.cancel(); submitTask?.cancel(); expiryTask?.cancel(); avatarTask?.cancel(); avatarGeneration = UUID(); avatarLoading = false
        backAnchor.routeVisible = false; backAnchor.routeEnabled = false
        challengeTask = nil; submitTask = nil; expiryTask = nil
        captchaState.invalidate(); challengeClient = nil; captchaLoading = false; busy = false
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews(); gradient.frame = view.bounds; scroll.frame = view.bounds
        let scale = view.bounds.width / 873
        let height = max(view.bounds.height, 1920 * scale)
        sheet.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: height)
        scroll.contentSize = CGSize(width: view.bounds.width, height: height)
        for item in placements {
            item.view.frame = CGRect(x: item.rect.minX * scale, y: item.rect.minY * scale, width: item.rect.width * scale, height: item.rect.height * scale)
            if let size = item.fontSize {
                (item.view as? UILabel)?.font = .systemFont(ofSize: size * scale)
                (item.view as? UITextField)?.font = .systemFont(ofSize: size * scale)
                (item.view as? UIButton)?.titleLabel?.font = .systemFont(ofSize: size * scale)
            }
            switch item.view.tag {
            case 701: item.view.layer.cornerRadius = item.view.bounds.height / 2
            case 702: item.view.layer.cornerRadius = 16 * scale
            case 703: item.view.layer.cornerRadius = 12 * scale
            default: break
            }
        }
    }
    private func place(_ node: UIView, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, font: CGFloat? = nil) {
        placements.append(Placement(view: node, rect: CGRect(x: x, y: y, width: width, height: height), fontSize: font)); sheet.addSubview(node)
    }
    private func label(_ text: String, color: UIColor = .black, align: NSTextAlignment = .left) -> UILabel {
        let label = UILabel(); label.text = text; label.textColor = color; label.textAlignment = align; return label
    }
    private func field(_ placeholder: String, value: String, id: String) -> UITextField {
        let input = UITextField(); input.text = value; input.placeholder = placeholder
        input.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: UIColor(red: 158/255, green: 158/255, blue: 166/255, alpha: 1)])
        input.textColor = UIColor(red: 32/255, green: 33/255, blue: 39/255, alpha: 1)
        input.autocorrectionType = .no; input.autocapitalizationType = .none; input.spellCheckingType = .no
        input.keyboardType = .asciiCapable; input.delegate = self; input.accessibilityIdentifier = id
        controls.append(input); return input
    }
    private func pill(_ color: UIColor) -> UIView { let node = UIView(); node.tag = 701; node.backgroundColor = color; node.layer.masksToBounds = true; return node }
    private func button(_ title: String, primary: Bool, action: Selector) -> UIButton {
        let button = UIButton(type: .custom); button.setTitle(title, for: .normal)
        button.tag = 701; button.backgroundColor = primary ? buttonBlue : .white; button.setTitleColor(primary ? .white : iconBlue, for: .normal)
        button.addTarget(self, action: action, for: .touchUpInside); controls.append(button); return button
    }
    private func remember() {
        if let input = accountInput { accountDraft = (input.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        if let input = passwordInput { passwordDraft = input.text ?? "" }
        if let input = nicknameInput { nicknameDraft = (input.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    }
    private func render() {
        avatarTask?.cancel(); avatarGeneration = UUID(); avatarLoading = false
        challengeTask?.cancel(); expiryTask?.cancel(); captchaState.invalidate(); challengeClient = nil; captchaLoading = false
        sheet.subviews.forEach { $0.removeFromSuperview() }; placements.removeAll(); controls.removeAll()
        accountInput = nil; passwordInput = nil; nicknameInput = nil; captchaInput = nil; captchaImage = nil; captchaButton = nil; refreshButton = nil; captchaStatus = nil
        view.backgroundColor = page == .register ? profileBackground : .clear; gradient.isHidden = page == .register
        sheet.backgroundColor = .clear; scroll.setContentOffset(.zero, animated: false)
        if page == .register { buildRegistration() } else { buildCredentials() }
        view.setNeedsLayout(); syncControls(); setNeedsStatusBarAppearanceUpdate()
        if page == .register && active { refreshCaptcha() }
    }
    private func buildCredentials() {
        let registering = page == .register
        let route = UIButton(type: .custom); route.tag = 703; route.setTitle("切换路线", for: .normal); route.setTitleColor(.black, for: .normal); route.backgroundColor = .white
        route.addTarget(self, action: #selector(showRoutes), for: .touchUpInside); route.accessibilityLabel = "切换路线"; route.accessibilityIdentifier = "auth_switch_route"; controls.append(route)
        place(route, 24, 78, 155, 47, font: 28)
        let title = label(registering ? "账号注册" : (addingAccount ? "添加账号" : "账号登录"), color: .white, align: .center); title.accessibilityIdentifier = "auth_title"
        place(title, 0, 292, 873, 106, font: 64)
        place(pill(fieldBackground), 58, 492, 757, 127)
        place(AuthReferenceIcon(.account, color: iconBlue), 92, 531, 48, 50)
        let account = field(registering ? "用户名：5–32位字母或数字" : "请输入用户名或手机号", value: accountDraft, id: "auth_account")
        account.accessibilityLabel = registering ? "用户名，5至32位，以字母开头，只含字母和数字" : "用户名或手机号"
        account.textContentType = .username; account.returnKeyType = .next; accountInput = account
        account.addTarget(self, action: #selector(rememberedAccountEdited), for: .editingChanged)
        place(account, 170, 507, 536, 97, font: 34)
        let saved = UIButton(type: .custom); saved.setImage(UIImage(systemName: "chevron.down"), for: .normal); saved.tintColor = iconBlue
        saved.accessibilityLabel = "选择已保存账号，最多10个"; saved.accessibilityIdentifier = "auth_saved_accounts"
        saved.addTarget(self, action: #selector(showRememberedAccounts), for: .touchUpInside); controls.append(saved); place(saved, 718, 509, 76, 94, font: 40)
        place(pill(fieldBackground), 58, 682, 757, 127)
        place(AuthReferenceIcon(.password, color: iconBlue), 92, 722, 48, 50)
        let password = field(registering ? "密码需要8~16位，须含字母和数字" : "请输入密码", value: passwordDraft, id: "auth_password")
        password.isSecureTextEntry = !passwordVisible; password.textContentType = registering ? .newPassword : .password; password.returnKeyType = .done; passwordInput = password
        place(password, 170, 697, 536, 97, font: 34)
        let eye = AuthReferenceIcon(passwordVisible ? .eye : .eyeOff, color: UIColor(white: 0.15, alpha: 1)); self.eye = eye
        place(eye, 718, 699, 76, 94)
        let toggle = UIButton(type: .custom); toggle.addTarget(self, action: #selector(togglePassword), for: .touchUpInside); toggle.accessibilityLabel = passwordVisible ? "隐藏密码" : "显示密码"; toggle.accessibilityIdentifier = "auth_password_toggle"; controls.append(toggle)
        place(toggle, 718, 699, 76, 94)
        let error = label("", color: .white, align: .center); error.numberOfLines = 2; error.accessibilityIdentifier = "auth_error"; errorLabel = error
        placeRememberChoice(y: 817, color: .white)
        place(error, 58, 917, 757, 68, font: 29)
        let primary = button(registering ? "注册" : "登录", primary: true, action: #selector(submit)); primary.accessibilityIdentifier = "auth_primary_action"; self.primary = primary
        place(primary, 58, 1005, 757, 116, font: 40)
        let secondary = button(registering ? "登录" : "注册", primary: false, action: #selector(switchMode)); secondary.accessibilityIdentifier = "auth_switch_mode"
        place(secondary, 58, 1161, 757, 116, font: 40)
        let brand = UIImageView(image: UIImage(named: "AuthBrand")); brand.contentMode = .scaleAspectFit; brand.accessibilityElementsHidden = true
        place(brand, 342, 1548, 189, 239)
    }
    private func buildRegistration() {
        let title = label("账号注册", align: .center); title.accessibilityIdentifier = "auth_title"
        place(title, 180, 84, 513, 80, font: 42)
        let back = UIButton(type: .custom); back.accessibilityIdentifier = "auth_back"; back.accessibilityLabel = "返回登录"; back.setImage(UIImage(systemName: "chevron.left"), for: .normal); back.tintColor = .black
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside); controls.append(back); place(back, 32, 84, 76, 80)
        let brand = UIImageView(image: UIImage(named: "AuthBrand")); brand.contentMode = .scaleAspectFit; place(brand, 340, 192, 193, 244)
        let avatar = UIButton(type: .custom); avatar.tag = 701; avatar.backgroundColor = UIColor(red: 237/255, green: 239/255, blue: 244/255, alpha: 1); avatar.clipsToBounds = true
        avatar.accessibilityIdentifier = "auth_register_avatar"; avatar.accessibilityLabel = "选择注册头像，必选"; avatar.addTarget(self, action: #selector(pickAvatar), for: .touchUpInside); avatarButton = avatar; controls.append(avatar)
        if let avatarData, let image = UIImage(data: avatarData) { avatar.setImage(image.withRenderingMode(.alwaysOriginal), for: .normal); avatar.imageView?.contentMode = .scaleAspectFill }
        else { avatar.setImage(UIImage(systemName: "camera.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 30)), for: .normal); avatar.tintColor = .gray; avatar.imageView?.contentMode = .center }
        place(avatar, 345, 480, 184, 184)
        let avatarHint = label(avatarData == nil ? "点击上传头像（必选）" : "点击更换头像", color: .gray, align: .center); avatarHint.accessibilityIdentifier = "auth_register_avatar_status"; avatarStatus = avatarHint
        place(avatarHint, 150, 677, 573, 50, font: 28)
        func row(_ y: CGFloat) { place(pill(.white), 58, y, 757, 112) }
        row(755)
        let account = field("用户名（5–10位字母+数字）", value: accountDraft, id: "auth_account"); account.accessibilityLabel = "用户名，5到10位，以字母开头，包含字母和数字"; account.textContentType = .username; account.returnKeyType = .next; accountInput = account
        place(account, 88, 765, 697, 92, font: 34)
        row(905)
        let nickname = field("昵称（网名/姓名/别称）", value: nicknameDraft, id: "auth_nickname"); nickname.keyboardType = .default; nickname.returnKeyType = .next; nicknameInput = nickname
        place(nickname, 88, 915, 697, 92, font: 34)
        row(1055)
        let password = field("密码（8–16位字母+数字）", value: passwordDraft, id: "auth_password"); password.isSecureTextEntry = !passwordVisible; password.textContentType = .newPassword; password.returnKeyType = .next; passwordInput = password
        place(password, 88, 1065, 610, 92, font: 34)
        let toggle = UIButton(type: .custom); toggle.accessibilityIdentifier = "auth_password_toggle"; toggle.accessibilityLabel = "显示或隐藏密码"; toggle.addTarget(self, action: #selector(togglePassword), for: .touchUpInside); controls.append(toggle); place(toggle, 718, 1064, 76, 94)
        let eyeIcon = AuthReferenceIcon(passwordVisible ? .eye : .eyeOff, color: .darkGray); eye = eyeIcon; place(eyeIcon, 718, 1064, 76, 94)
        row(1205)
        let goV2 = APIClient.shared.isGoV2
        let code = field(goV2 ? "5位字母或数字验证码" : "4位数字验证码", value: "", id: "auth_captcha_code")
        code.keyboardType = goV2 ? .asciiCapable : .asciiCapableNumberPad; code.autocapitalizationType = .allCharacters
        code.textContentType = nil; code.returnKeyType = .done; captchaInput = code
        let toolbar = UIToolbar(); toolbar.sizeToFit(); toolbar.items = [UIBarButtonItem(systemItem: .flexibleSpace), UIBarButtonItem(title: "完成", style: .done, target: self, action: #selector(dismissKeyboard))]; code.inputAccessoryView = toolbar
        place(code, 88, 1215, 340, 92, font: 34)
        let imageButton = UIButton(type: .custom); imageButton.accessibilityLabel = "验证码图片，点击换一张"; imageButton.accessibilityIdentifier = "auth_captcha_image"; imageButton.addTarget(self, action: #selector(refreshCaptcha), for: .touchUpInside); controls.append(imageButton); captchaButton = imageButton
        place(imageButton, 455, 1215, 330, 92)
        let image = UIImageView(); image.contentMode = .scaleAspectFit; image.isUserInteractionEnabled = false; captchaImage = image; place(image, 455, 1215, 330, 92)
        let status = label("正在加载验证码…", color: .gray); status.accessibilityIdentifier = "auth_captcha_status"; captchaStatus = status; place(status, 58, 1328, 500, 45, font: 24)
        let refresh = UIButton(type: .custom); refresh.setTitle("换一张", for: .normal); refresh.setTitleColor(buttonBlue, for: .normal); refresh.addTarget(self, action: #selector(refreshCaptcha), for: .touchUpInside); refresh.accessibilityIdentifier = "auth_captcha_refresh"; controls.append(refresh); refreshButton = refresh; place(refresh, 600, 1328, 215, 45, font: 25)
        placeRememberChoice(y: 1390, color: .gray)
        let error = label("", color: .systemRed, align: .center); error.numberOfLines = 4; error.lineBreakMode = .byCharWrapping; error.accessibilityIdentifier = "auth_error"; errorLabel = error; place(error, 58, 1490, 757, 210, font: 40)
        let complete = button("注册", primary: true, action: #selector(submit)); complete.accessibilityIdentifier = "auth_primary_action"; primary = complete; place(complete, 58, 1730, 757, 116, font: 40)
    }

    private func loadRememberedDefault() {
        guard page == .login, !appLock.isLocked else { return }
        do {
            let rows = try IOSRememberedLogins.accounts(server: rememberedServer)
            guard let first = rows.first(where: { !addingAccount || $0.userID != session.user?.id }) else { return }
            let saved = try IOSRememberedLogins.credential(id: first.id, server: rememberedServer)
            autofilled = saved; accountDraft = saved.metadata.account; passwordDraft = saved.password; passwordVisible = false
        } catch { rememberedReadError = "无法读取已记住的账号，请手动登录" }
    }
    private func refreshRememberedServer() {
        guard rememberedServer != APIClient.shared.serverIdentity else { return }
        rememberedServer = APIClient.shared.serverIdentity; autofilled = nil; accountDraft = ""; passwordDraft = ""; rememberedReadError = ""
        loadRememberedDefault(); if isViewLoaded { render(); if !rememberedReadError.isEmpty { showError(rememberedReadError) } }
    }
    private func placeRememberChoice(y: CGFloat, color: UIColor) {
        let choice = UIButton(type: .custom); choice.contentHorizontalAlignment = .leading
        choice.setTitle(" 记住密码（本机最多10个账号）", for: .normal); choice.setTitleColor(color, for: .normal); choice.tintColor = color
        choice.accessibilityIdentifier = "auth_remember_password"; choice.addTarget(self, action: #selector(toggleRememberPassword), for: .touchUpInside)
        rememberButton = choice; controls.append(choice); updateRememberChoice(); place(choice, 58, y, 757, 96, font: 29)
    }
    private func updateRememberChoice() {
        rememberButton?.setImage(UIImage(systemName: rememberPassword ? "checkmark.square.fill" : "square"), for: .normal)
        rememberButton?.accessibilityValue = rememberPassword ? "已勾选" : "未勾选"
    }
    @objc private func toggleRememberPassword() {
        guard !busy, !appLock.isLocked else { return }
        guard rememberedServer == APIClient.shared.serverIdentity else { refreshRememberedServer(); return }
        rememberPassword.toggle()
        if !rememberPassword {
            do { try IOSRememberedLogins.remove(server: rememberedServer, id: autofilled?.metadata.id, account: accountInput?.text) }
            catch { rememberPassword = true; showError("无法移除保存的账号，请重试") }
        }
        updateRememberChoice()
    }
    @objc private func rememberedAccountEdited() {
        guard let saved = autofilled, (accountInput?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).caseInsensitiveCompare(saved.metadata.account) != .orderedSame else { return }
        if passwordInput?.text == saved.password { passwordInput?.text = ""; passwordDraft = "" }
        autofilled = nil
    }
    @objc private func showRememberedAccounts() {
        guard !busy, !appLock.isLocked, page == .login else { return }
        refreshRememberedServer(); view.endEditing(true)
        let server = rememberedServer
        let picker = IOSRememberedLoginPicker(server: server, selected: { [weak self] row in
            guard let self, !self.appLock.isLocked, self.page == .login, server == self.rememberedServer, server == APIClient.shared.serverIdentity else { return }
            do {
                let saved = try IOSRememberedLogins.credential(id: row.id, server: server)
                self.autofilled = saved; self.accountDraft = saved.metadata.account; self.passwordDraft = saved.password
                self.accountInput?.text = saved.metadata.account; self.passwordInput?.text = saved.password
                self.passwordVisible = false; self.passwordInput?.isSecureTextEntry = true; self.eye?.kind = .eyeOff
                self.rememberPassword = true; self.updateRememberChoice()
            } catch { self.showError(error.localizedDescription) }
        }, removed: { [weak self] row in
            guard let self, self.autofilled?.metadata.id == row.id else { return }
            self.autofilled = nil; self.passwordDraft = ""; self.passwordInput?.text = ""
        }).environmentObject(appLock)
        let controller = UIHostingController(rootView: picker); controller.modalPresentationStyle = .pageSheet
        controller.sheetPresentationController?.detents = [.medium(), .large()]
        present(controller, animated: true)
    }
    @objc private func dismissKeyboard() { view.endEditing(true) }
    @objc private func pickAvatar() {
        guard active, page == .register, !busy, !avatarLoading, presentedViewController == nil else { return }
        remember(); view.endEditing(true)
        var configuration = PHPickerConfiguration(photoLibrary: .shared()); configuration.filter = .images; configuration.selectionLimit = 1
        let picker = PHPickerViewController(configuration: configuration); picker.delegate = self; present(picker, animated: true)
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let provider = results.first?.itemProvider
        picker.dismiss(animated: true) { [weak self] in
            guard let self, let provider, self.page == .register else { return }
            self.active = true
            let revision = UUID(); self.avatarGeneration = revision; self.avatarLoading = true; self.avatarStatus?.text = "正在处理头像…"; self.showError(""); self.syncControls()
            self.avatarTask = Task { [weak self] in
                guard let self else { return }
                do {
                    let raw: Data = try await withCheckedThrowingContinuation { continuation in
                        provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { bytes, error in
                            if let error { continuation.resume(throwing: error) }
                            else if let bytes { continuation.resume(returning: bytes) }
                            else { continuation.resume(throwing: APIClientError.server("头像无法读取，请重新选择")) }
                        }
                    }
                    let prepared = try await AvatarImageProcessor.prepare(raw, maximumPixel: 768)
                    guard !Task.isCancelled, self.active, self.page == .register, self.avatarGeneration == revision else { return }
                    self.avatarData = prepared; self.avatarButton?.setImage(UIImage(data: prepared)?.withRenderingMode(.alwaysOriginal), for: .normal); self.avatarButton?.imageView?.contentMode = .scaleAspectFill; self.avatarStatus?.text = "点击更换头像"
                } catch {
                    guard !Task.isCancelled, self.active, self.page == .register, self.avatarGeneration == revision else { return }
                    self.showError(error.localizedDescription); self.avatarStatus?.text = "请选择头像（必选）"
                }
                self.avatarLoading = false; self.syncControls()
            }
        }
    }
    private func syncControls() {
        backAnchor.routeVisible = active
        backAnchor.routeEnabled = active && !busy && page != .login && !appLock.isLocked && !session.updateRequired
        backAnchor.routeIdentity = [String(describing: page), session.token ?? "", APIClient.shared.endpointIdentity]
        controls.forEach { $0.isEnabled = !busy }
        primary?.setTitle(busy ? (page == .register ? "注册中…" : "登录中…") : page == .register ? "注册" : "登录", for: .normal)
        if page == .register {
            let valid = captchaState.valid(endpoint: APIClient.shared.endpointIdentity, now: uptime)
            primary?.isEnabled = !busy && !avatarLoading && !captchaLoading && valid; captchaInput?.isEnabled = !busy && valid
            captchaButton?.isEnabled = !busy && !captchaLoading; refreshButton?.isEnabled = !busy && !captchaLoading
        }
        primary?.alpha = primary?.isEnabled == true ? 1 : 0.55
    }
    private func showError(_ text: String) { errorLabel?.text = text; UIAccessibility.post(notification: .announcement, argument: text) }
    @objc private func switchMode() { guard !busy else { return }; remember(); if autofilled != nil { passwordDraft = ""; autofilled = nil }; view.endEditing(true); page = page == .register ? .login : .register; render() }
    @objc private func goBack() { guard !busy else { return }; remember(); view.endEditing(true); page = .login; render() }
    private func swipeBack() {
        guard active, !busy, page != .login, !appLock.isLocked, !session.updateRequired else { return }
        remember(); view.endEditing(true); page = .login; render()
    }
    @objc private func togglePassword() {
        passwordVisible.toggle(); passwordInput?.isSecureTextEntry = !passwordVisible; eye?.kind = passwordVisible ? .eye : .eyeOff
        controls.first(where: { $0.accessibilityIdentifier == "auth_password_toggle" })?.accessibilityLabel = passwordVisible ? "隐藏密码" : "显示密码"
    }
    @objc private func showRoutes() { guard !busy else { return }; guard !addingAccount else { showError("添加账号使用当前服务器线路"); return }; view.endEditing(true); present(UIHostingController(rootView: RoutePickerView().environmentObject(session).environmentObject(appLock).onDisappear { [weak self] in self?.refreshRememberedServer() }), animated: true) }
    @objc private func didBecomeActive() {
        refreshRememberedServer()
        if page == .register && !captchaLoading && !captchaState.valid(endpoint: APIClient.shared.endpointIdentity, now: uptime) {
            captchaState.invalidate(); captchaInput?.text = ""; captchaStatus?.text = "验证码已过期，请换一张"; syncControls()
        }
    }
    @objc private func refreshCaptcha() {
        guard active, page == .register, !busy, !captchaLoading else { return }
        challengeTask?.cancel(); expiryTask?.cancel()
        let request = captchaState.invalidate(); let client = APIClient.shared.captureAnonymousSession(); challengeClient = nil
        let started = uptime; captchaLoading = true; captchaInput?.text = ""; captchaImage?.image = nil; captchaStatus?.text = "正在加载验证码…"; syncControls()
        challengeTask = Task { [weak self] in
            guard let self else { return }
            do {
                let challenge = try await client.registerChallenge(); try Task.checkCancellation()
                guard self.active, self.page == .register, request == self.captchaState.generation else { return }
                guard client.endpointIdentity == APIClient.shared.endpointIdentity else { throw APIClientError.server("线路已变更，请换一张验证码") }
                guard challenge.codeLength == (APIClient.shared.isGoV2 ? 5 : 4), challenge.imageDataURL.count <= 262144, challenge.imageDataURL.hasPrefix("data:image/png;base64,"),
                      let bytes = Data(base64Encoded: String(challenge.imageDataURL.dropFirst("data:image/png;base64,".count))),
                      bytes.starts(with: [137,80,78,71,13,10,26,10]),
                      let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                      (1...1600).contains(width), (1...600).contains(height),
                      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw APIClientError.server("验证码图片无效，请换一张") }
                guard self.captchaState.install(id: challenge.challengeID, endpoint: client.endpointIdentity, ttl: challenge.expiresIn, requestedAt: started, now: self.uptime, generation: request) else { throw APIClientError.server("验证码已过期，请换一张") }
                self.challengeClient = client; self.captchaImage?.image = UIImage(cgImage: cgImage)
                self.captchaStatus?.text = APIClient.shared.isGoV2 ? "请输入图片中的5位字母或数字" : "请输入图片中的4位数字"
                let remaining = max(0, (self.captchaState.proof?.deadline ?? self.uptime) - self.uptime)
                self.expiryTask = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) } catch { return }
                    guard let self, self.active, request == self.captchaState.generation else { return }
                    self.captchaState.invalidate(); self.challengeClient = nil; self.captchaInput?.text = ""; self.captchaStatus?.text = "验证码已过期，请换一张"; self.syncControls()
                }
            } catch {
                guard self.active, request == self.captchaState.generation, !Task.isCancelled else { return }
                self.captchaStatus?.text = error.localizedDescription
            }
            guard self.active, request == self.captchaState.generation else { return }
            self.captchaLoading = false; self.syncControls()
        }
    }
    @objc private func submit() {
        guard !busy, active else { return }; remember(); showError("")
        guard rememberedServer == APIClient.shared.serverIdentity else { refreshRememberedServer(); showError("线路已改变，请重新选择账号"); return }
        if page == .register { submitRegistration(); return }
        if accountDraft.isEmpty || passwordDraft.isEmpty { showError("请输入账号和密码"); return }
        signIn()
    }
    private func signIn(twoStepCode: String = "") {
        view.endEditing(true); busy = true; syncControls()
        let account = accountDraft, password = passwordDraft
        let rememberChoice = rememberPassword
        submitTask = Task { [weak self] in
            guard let self else { return }
            await self.session.loadClientConfig()
            guard self.active, !Task.isCancelled else { return }
            guard !self.appLock.isLocked else { self.busy = false; self.syncControls(); return }
            var succeeded = false
            if !self.session.updateRequired { succeeded = await self.session.signIn(phone: account, password: password, twoStepCode: twoStepCode, addingAccount: self.addingAccount, expectedToken: self.ownerToken, rememberPassword: rememberChoice) }
            guard self.active, !Task.isCancelled else { return }
            self.busy = false; self.syncControls()
            if succeeded { self.passwordDraft = ""; self.passwordInput?.text = ""; self.onAuthenticated?() }
            else {
                self.showError(self.session.updateRequired ? "请先更新客户端" : self.session.error)
                if self.session.error.contains("两步验证") { self.promptTwoStep() }
            }
        }
    }
    private func promptTwoStep() {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "两步验证", message: "请输入两步验证密码或恢复码", preferredStyle: .alert)
        alert.addTextField { field in field.isSecureTextEntry = true; field.placeholder = "两步验证密码或恢复码"; field.autocorrectionType = .no; field.autocapitalizationType = .none }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "验证", style: .default) { [weak self, weak alert] _ in
            guard let value = alert?.textFields?.first?.text, !value.isEmpty else { return }; self?.signIn(twoStepCode: value)
        }); present(alert, animated: true)
    }
    private func submitRegistration() {
        guard !avatarLoading, let avatarData else { showError("请先选择头像"); return }
        if let error = RegistrationRules.accountError(accountDraft, password: passwordDraft) { showError(error); return }
        if let error = RegistrationRules.nicknameError(nicknameDraft) { showError(error); return }
        let code = (captchaInput?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard RegistrationRules.isCaptchaCode(code, goV2: APIClient.shared.isGoV2) else { showError(APIClient.shared.isGoV2 ? "请输入图片中的5位字母或数字" : "请输入图片中的4位数字"); captchaInput?.becomeFirstResponder(); return }
        guard let client = challengeClient, captchaState.valid(endpoint: APIClient.shared.endpointIdentity, now: uptime) else { showError("请先刷新并填写有效的图形验证码"); refreshCaptcha(); return }
        view.endEditing(true); busy = true; syncControls()
        let username = accountDraft, password = passwordDraft, nickname = nicknameDraft
        let rememberChoice = rememberPassword
        submitTask = Task { [weak self] in
            guard let self else { return }; var posted = false; var created = false
            do {
                await self.session.loadClientConfig(); try Task.checkCancellation()
                guard self.active else { return }
                guard !self.session.updateRequired else { throw APIClientError.server("请先更新客户端") }
                guard !self.appLock.isLocked else { throw CancellationError() }
                guard !self.addingAccount || (self.session.isSignedIn && self.session.token == self.ownerToken) else { throw APIClientError.server("当前账号已改变，请重新打开添加账号") }
                guard client.endpointIdentity == APIClient.shared.endpointIdentity,
                      let proof = self.captchaState.consume(endpoint: client.endpointIdentity, now: self.uptime) else { throw APIClientError.server("验证码已过期或线路改变，请换一张") }
                self.challengeClient = nil; self.expiryTask?.cancel(); self.captchaInput?.text = ""; self.captchaStatus?.text = "正在验证…"
                posted = true
                let result = try await client.register(username: username, password: password, nickname: nickname, captchaID: proof.id, captchaCode: code, avatarData: avatarData)
                created = true
                if Task.isCancelled || !self.active {
                    let abandoned = client.captureAnonymousSession(); abandoned.token = result.accessToken
                    Task { try? await abandoned.logout() }; return
                }
                try Task.checkCancellation(); guard self.active else { return }
                try self.session.acceptRegistration(result: result, username: username, nickname: nickname, client: client, addingAccount: self.addingAccount, expectedToken: self.ownerToken)
                self.session.rememberAuthenticatedLogin(account: username, password: password, remember: rememberChoice)
                self.passwordDraft = ""; self.busy = false; self.onAuthenticated?()
            } catch {
                guard self.active, !Task.isCancelled else { return }
                self.busy = false
                if created {
                    self.page = .login; self.render()
                    self.showError(error.localizedDescription.contains("账号已创建") ? error.localizedDescription : "账号已创建，请返回原线路使用新账号登录")
                    return
                }
                let nsError = error as NSError
                self.showError(posted && nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut ? "请求超时。如账号已创建，请返回登录；否则换一张验证码重试。" : error.localizedDescription)
                self.syncControls()
                if posted || !self.captchaState.valid(endpoint: APIClient.shared.endpointIdentity, now: self.uptime) { self.refreshCaptcha() }
            }
        }
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === accountInput { if page == .register { nicknameInput?.becomeFirstResponder() } else { passwordInput?.becomeFirstResponder() } }
        else if textField === nicknameInput { passwordInput?.becomeFirstResponder() }
        else if textField === passwordInput && page == .register { captchaInput?.becomeFirstResponder() }
        else { submit() }; return true
    }
    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        guard !busy, let current = textField.text, let swiftRange = Range(range, in: current) else { return false }
        let value = current.replacingCharacters(in: swiftRange, with: string)
        if textField === captchaInput {
            let goV2 = APIClient.shared.isGoV2
            return value.count <= (goV2 ? 5 : 4) && value.unicodeScalars.allSatisfy { CharacterSet(charactersIn: goV2 ? "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" : "0123456789").contains($0) }
        }
        if textField === accountInput { return value.count <= (page == .register ? 10 : 32) }
        if textField === passwordInput { return value.utf8.count <= (page == .register ? 16 : 128) }
        return value.unicodeScalars.count <= 32
    }
    @objc private func keyboardChanged(_ notification: Notification) {
        guard let raw = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let rectangle = view.convert(raw, from: nil); let overlap = max(0, view.bounds.maxY - rectangle.minY)
        scroll.contentInset.bottom = overlap; scroll.verticalScrollIndicatorInsets.bottom = overlap
        if let field = controls.first(where: { $0.isFirstResponder }) { scroll.scrollRectToVisible(field.frame.insetBy(dx: -12, dy: -24), animated: true) }
    }
}

/// Android's AuthIconView vector geometry, rendered without font substitutions.
private final class AuthReferenceIcon: UIView {
    enum Kind: Equatable { case account, password, eye, eyeOff, back }
    var kind: Kind { didSet { setNeedsDisplay() } }
    private let color: UIColor
    init(_ kind: Kind, color: UIColor) { self.kind = kind; self.color = color; super.init(frame: .zero); isOpaque = false; isUserInteractionEnabled = false; accessibilityElementsHidden = true }
    required init?(coder: NSCoder) { fatalError("Use init(_:color:)") }
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }; context.saveGState(); defer { context.restoreGState() }
        color.setStroke(); color.setFill()
        let side = min(bounds.width, bounds.height) * ((kind == .eye || kind == .eyeOff) ? 0.7 : 1)
        context.translateBy(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2); context.scaleBy(x: side / 48, y: side / 48)
        let path = UIBezierPath(); path.lineWidth = kind == .back ? 2.2 : 3.3; path.lineCapStyle = .round; path.lineJoinStyle = .round
        switch kind {
        case .account:
            path.append(UIBezierPath(ovalIn: CGRect(x: 16, y: 4, width: 16, height: 16)))
            path.move(to: CGPoint(x: 6, y: 44)); path.addCurve(to: CGPoint(x: 42, y: 44), controlPoint1: CGPoint(x: 7, y: 21), controlPoint2: CGPoint(x: 41, y: 21))
        case .password:
            path.append(UIBezierPath(roundedRect: CGRect(x: 7, y: 22, width: 34, height: 23), cornerRadius: 1.5)); path.move(to: CGPoint(x: 14, y: 22)); path.addLine(to: CGPoint(x: 14, y: 14)); path.addCurve(to: CGPoint(x: 34, y: 14), controlPoint1: CGPoint(x: 14, y: 0), controlPoint2: CGPoint(x: 34, y: 0)); path.addLine(to: CGPoint(x: 34, y: 22)); path.move(to: CGPoint(x: 24, y: 30)); path.addLine(to: CGPoint(x: 24, y: 37))
        case .eye, .eyeOff:
            path.move(to: CGPoint(x: 4, y: 24)); path.addCurve(to: CGPoint(x: 44, y: 24), controlPoint1: CGPoint(x: 14, y: 9), controlPoint2: CGPoint(x: 34, y: 9)); path.addCurve(to: CGPoint(x: 4, y: 24), controlPoint1: CGPoint(x: 34, y: 39), controlPoint2: CGPoint(x: 14, y: 39)); path.append(UIBezierPath(ovalIn: CGRect(x: 18, y: 18, width: 12, height: 12))); if kind == .eyeOff { path.move(to: CGPoint(x: 5, y: 7)); path.addLine(to: CGPoint(x: 43, y: 41)) }
        case .back: path.move(to: CGPoint(x: 27, y: 11)); path.addLine(to: CGPoint(x: 15, y: 24)); path.addLine(to: CGPoint(x: 27, y: 37))
        }; path.stroke()
    }
}
