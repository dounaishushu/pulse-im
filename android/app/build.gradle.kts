import groovy.json.JsonSlurper
import java.net.URI

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

fun configured(name: String) = providers.gradleProperty(name).orNull ?: System.getenv(name) ?: ""
val releaseApi = configured("PULSE_API_URL")
val releaseWs = configured("PULSE_WS_URL")
val backendProtocol = configured("PULSE_BACKEND_PROTOCOL").ifBlank { "go-v2" }
require(backendProtocol in listOf("go-v2", "legacy")) { "PULSE_BACKEND_PROTOCOL must be go-v2 or legacy" }
val firebaseFile = file("google-services.json")
val firebase = if (firebaseFile.isFile) JsonSlurper().parse(firebaseFile) as Map<*, *> else emptyMap<Any, Any>()
val firebaseProject = firebase["project_info"] as? Map<*, *> ?: emptyMap<Any, Any>()
val firebaseClient = (firebase["client"] as? List<*>)?.mapNotNull { it as? Map<*, *> }?.firstOrNull {
    val info = it["client_info"] as? Map<*, *>; val androidInfo = info?.get("android_client_info") as? Map<*, *>
    androidInfo?.get("package_name") == "com.pulseim.android"
}
val firebaseInfo = firebaseClient?.get("client_info") as? Map<*, *>
val firebaseApi = (firebaseClient?.get("api_key") as? List<*>)?.firstOrNull() as? Map<*, *>
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
val fcmConfigured = firebaseClient != null && firebaseInfo?.get("mobilesdk_app_id") != null && firebaseApi?.get("current_key") != null && firebaseProject["project_number"] != null
fun productionEndpoint(value: String, scheme: String): Boolean = runCatching {
    val u = URI(value); val host = u.host?.lowercase() ?: return@runCatching false
    u.scheme == scheme && u.userInfo == null && u.fragment == null && host.contains('.') && !host.contains(':') &&
        listOf("localhost", "local", "lan", "internal", "test", "invalid", "example", "example.com", "example.org", "example.net").none { host == it || host.endsWith(".$it") } &&
        host.split('.').all { Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?").matches(it) } && !Regex("[0-9.]+").matches(host)
}.getOrDefault(false)
val signingPath = configured("PULSE_SIGNING_STORE")
val verifyProductionConfig = tasks.register("verifyProductionConfig") {
    doLast {
        check(productionEndpoint(releaseApi, "https")) { "Release blocked: configure PULSE_API_URL with your production HTTPS domain." }
        check(productionEndpoint(releaseWs, "wss")) { "Release blocked: configure PULSE_WS_URL with your production WSS domain." }
        check(fcmConfigured) { "Release blocked: add a valid app/google-services.json for com.pulseim.android; FCM has not been provisioned." }
        check(signingPath.isNotBlank() && file(signingPath).isFile && configured("PULSE_SIGNING_PASSWORD").isNotBlank() && configured("PULSE_SIGNING_ALIAS").isNotBlank() && configured("PULSE_SIGNING_KEY_PASSWORD").isNotBlank()) { "Release blocked: configure the production signing keystore and PULSE_SIGNING_* values." }
    }
}

android { namespace = "com.pulseim.android"; compileSdk = 35
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "com.pulseim.android"
        buildConfigField("boolean", "GO_BACKEND", (backendProtocol == "go-v2").toString())
        minSdk = 26
        testInstrumentationRunner = "com.pulseim.android.GoV2Probe"
        targetSdk = 35
        versionCode = 86
        versionName = "0.2.84"
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["pushServiceEnabled"] = fcmConfigured.toString()
        val routeTrust = groovy.json.JsonSlurper().parse(file("../../mobile-contracts/route-trust.json")) as Map<*, *>
        buildConfigField("String", "ROUTE_CLUSTER_ID", quoted(configured("PULSE_ROUTE_CLUSTER_ID").ifBlank { routeTrust["cluster_id"].toString() }))
        buildConfigField("String", "ROUTE_PUBLIC_KEY_SPKI", quoted(configured("PULSE_ROUTE_PUBLIC_KEY_SPKI").ifBlank { routeTrust["public_key_spki"].toString() }))
        val useProductionRoutes = configured("PULSE_ROUTE_CLUSTER_ID").isBlank() && (routeTrust["seed_routes"] as List<*>).any { (it as Map<*, *>)["api_url"] == releaseApi }
        buildConfigField("String", "ROUTE_SEEDS_JSON", quoted(if (useProductionRoutes) groovy.json.JsonOutput.toJson(routeTrust["seed_routes"]) else "[]"))
        buildConfigField("String", "ROUTE_DISCOVERY_JSON", quoted(if (useProductionRoutes) groovy.json.JsonOutput.toJson(routeTrust["discovery_urls"]) else "[]"))
        buildConfigField("boolean", "FCM_CONFIGURED", fcmConfigured.toString())
        buildConfigField("String", "FIREBASE_APP_ID", quoted(firebaseInfo?.get("mobilesdk_app_id")?.toString() ?: ""))
        buildConfigField("String", "FIREBASE_API_KEY", quoted(firebaseApi?.get("current_key")?.toString() ?: ""))
        buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(firebaseProject["project_id"]?.toString() ?: ""))
        buildConfigField("String", "FIREBASE_SENDER_ID", quoted(firebaseProject["project_number"]?.toString() ?: ""))
    }
    signingConfigs { if (signingPath.isNotBlank()) create("production") {
        storeFile = file(signingPath); storePassword = configured("PULSE_SIGNING_PASSWORD")
        keyAlias = configured("PULSE_SIGNING_ALIAS"); keyPassword = configured("PULSE_SIGNING_KEY_PASSWORD")
    } }
    buildTypes {
        debug {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            resValue("string", "pulse_api_base_url", releaseApi.ifBlank { "http://10.0.2.2:8080/api/v2" })
            resValue("string", "pulse_websocket_url", releaseWs.ifBlank { "ws://10.0.2.2:8080/api/v2/realtime" })
        }
        release {
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            resValue("string", "pulse_api_base_url", releaseApi)
            resValue("string", "pulse_websocket_url", releaseWs)
            if (signingPath.isNotBlank()) signingConfig = signingConfigs.getByName("production")
        }
    }
    sourceSets.getByName("main").java.srcDir(if (fcmConfigured) "src/fcm/java" else "src/noPush/java")
}
tasks.configureEach { if (name == "preReleaseBuild") dependsOn(verifyProductionConfig) }

kotlin { jvmToolchain(17) }

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.zxing:core:3.5.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.belerweb:pinyin4j:2.5.1")
    if (fcmConfigured) { implementation(platform("com.google.firebase:firebase-bom:35.0.0")); implementation("com.google.firebase:firebase-messaging") }
}
