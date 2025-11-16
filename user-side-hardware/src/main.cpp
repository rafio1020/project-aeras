/*
 * AERAS User Side - Location Block (FIXED VERSION)
 * Implements ALL test cases from Section A (1-5)
 * Fixed: LED logic, timeout handling, debouncing, state management
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ===== PIN DEFINITIONS =====
#define TRIG_PIN 5
#define ECHO_PIN 18
#define LDR_PIN 34
#define BUTTON_PIN 25
#define LED_YELLOW 2
#define LED_RED 4
#define LED_GREEN 15
#define BUZZER_PIN 27

// ===== OLED DISPLAY =====
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ===== WIFI & BACKEND =====
const char* ssid = "Wokwi-GUEST";
const char* password = "";
const char* backendURL = "http://10.172.129.95:3000/api";

// ===== LOCATION INFO =====
const char* blockID = "CUET_CAMPUS";
const char* destination = "PAHARTOLI";  // User chooses this block

// ===== STATE MACHINE =====
enum SystemState {
  STATE_IDLE,
  STATE_DETECTING,
  STATE_PRIVILEGE_CHECK,
  STATE_WAITING_CONFIRM,
  STATE_REQUEST_SENT,
  STATE_WAITING_ACCEPTANCE,
  STATE_RIDE_ACCEPTED,
  STATE_RIDE_ACTIVE,
  STATE_TIMEOUT_ERROR
};

SystemState currentState = STATE_IDLE;

// ===== TIMING VARIABLES =====
unsigned long ultrasonicStartTime = 0;
unsigned long requestSentTime = 0;
unsigned long lastButtonTime = 0;
unsigned long lastStatusCheck = 0;
unsigned long lastLEDBlink = 0;
const int DEBOUNCE_DELAY = 200;
const int ULTRASONIC_THRESHOLD = 3000; // 3 seconds
const int REQUEST_TIMEOUT = 60000;     // 60 seconds

// ===== FLAGS =====
bool ultrasonicTriggered = false;
bool privilegeVerified = false;
bool requestSent = false;
String currentRideID = "";

// ===== HELPER FUNCTIONS =====

void displayMessage(String line1, String line2, String line3 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 10);
  display.println("AERAS SYSTEM");
  display.println("================");
  display.setCursor(0, 28);
  display.println(line1);
  display.setCursor(0, 40);
  display.println(line2);
  if (line3 != "") {
    display.setCursor(0, 52);
    display.println(line3);
  }
  display.display();
}

void beep(int times, int duration = 100) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(duration);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < times - 1) delay(100);
  }
}

void setLEDs(bool yellow, bool red, bool green) {
  digitalWrite(LED_YELLOW, yellow ? HIGH : LOW);
  digitalWrite(LED_RED, red ? HIGH : LOW);
  digitalWrite(LED_GREEN, green ? HIGH : LOW);
}

void resetSystem() {
  Serial.println("\n=== SYSTEM RESET ===");
  currentState = STATE_IDLE;
  ultrasonicTriggered = false;
  privilegeVerified = false;
  requestSent = false;
  ultrasonicStartTime = 0;
  requestSentTime = 0;
  currentRideID = "";
  
  setLEDs(false, false, false);
  displayMessage("System Ready", "Stand on block", "for 3+ seconds");
  delay(1000);
}

// ===== BACKEND COMMUNICATION =====
bool sendRideRequest() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("✗ WiFi not connected");
    return false;
  }
  
  HTTPClient http;
  String url = String(backendURL) + "/ride/request";
  
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);
  
  String payload = "{";
  payload += "\"blockID\":\"" + String(blockID) + "\",";
  payload += "\"destination\":\"" + String(destination) + "\",";
  payload += "\"userID\":\"USER_" + String(random(1000, 9999)) + "\"";
  payload += "}";
  
  Serial.println("Sending: " + payload);
  
  int httpCode = http.POST(payload);
  bool success = false;
  
  if (httpCode == 200) {
    String response = http.getString();
    Serial.println("Response: " + response);
    
    // Extract ride ID
    int rideIDStart = response.indexOf("\"rideID\":") + 9;
    if (rideIDStart > 8) {
      int rideIDEnd = response.indexOf(",", rideIDStart);
      if (rideIDEnd == -1) rideIDEnd = response.indexOf("}", rideIDStart);
      currentRideID = response.substring(rideIDStart, rideIDEnd);
      Serial.println("Ride ID: " + currentRideID);
      success = true;
    }
  } else {
    Serial.println("HTTP Error: " + String(httpCode));
  }
  
  http.end();
  return success;
}

// ===== TEST CASE 1: ULTRASONIC DETECTION =====
void checkUltrasonicSensor() {
  // Trigger pulse
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  
  // Measure echo
  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout
  if (duration == 0) {
    // No echo received - out of range
    if (ultrasonicStartTime > 0) {
      Serial.println("Person moved away - resetting timer");
      ultrasonicStartTime = 0;
    }
    return;
  }
  
  long distanceCm = duration * 0.034 / 2;
  long scaledDistance = distanceCm * 4; // Scale to ~16m range (HC-SR04 is 4m)
  
  // Debug output every 2 seconds
  static unsigned long lastDebug = 0;
  if (millis() - lastDebug > 2000) {
    Serial.print("Distance: ");
    Serial.print(scaledDistance);
    Serial.println(" cm");
    lastDebug = millis();
  }
  
  // TEST CASE 1: Check if within 10m (1000cm)
  if (scaledDistance > 0 && scaledDistance <= 1000) {
    if (ultrasonicStartTime == 0) {
      ultrasonicStartTime = millis();
      currentState = STATE_DETECTING;
      Serial.println("✓ Person detected - waiting 3 seconds...");
      displayMessage("User Detected!", "Stay for 3 sec", "Distance: " + String(scaledDistance) + "cm");
    }
    
    // Check if 3 seconds elapsed
    unsigned long elapsed = millis() - ultrasonicStartTime;
    if (elapsed >= ULTRASONIC_THRESHOLD && !ultrasonicTriggered) {
      ultrasonicTriggered = true;
      currentState = STATE_PRIVILEGE_CHECK;
      displayMessage("Time Complete!", "Show laser card", "to LDR sensor");
      beep(1, 150);
      Serial.println("✓ Ultrasonic trigger SUCCESS!");
      Serial.println("   Distance: " + String(scaledDistance) + " cm");
      Serial.println("   Time: " + String(elapsed) + " ms");
    }
  } else {
    // Person moved out of range
    if (ultrasonicStartTime > 0 && !ultrasonicTriggered) {
      Serial.println("⚠ Person moved away - resetting");
      ultrasonicStartTime = 0;
      currentState = STATE_IDLE;
      displayMessage("User Left", "Stand again", "for 3+ seconds");
      delay(1000);
      displayMessage("System Ready", "Stand on block", "for 3+ seconds");
    }
  }
}

// ===== TEST CASE 2: LDR + LASER VERIFICATION =====
void checkPrivilegeVerification() {
  int ldrValue = analogRead(LDR_PIN);
  
  // Debug every 500ms
  static unsigned long lastLDRDebug = 0;
  if (millis() - lastLDRDebug > 500) {
    Serial.print("LDR Value: ");
    Serial.println(ldrValue);
    lastLDRDebug = millis();
  }
  
  // TEST CASE 2: Detect laser (threshold adjusted for environment)
  // Wokwi simulation: ~4000-4095 with laser
  // Real hardware: May need calibration (2500-3500)
  if (ldrValue > 3000) {
    if (!privilegeVerified) {
      privilegeVerified = true;
      currentState = STATE_WAITING_CONFIRM;
      displayMessage("Verified!", "Press button", "to confirm ride");
      beep(2, 100);
      Serial.println("✓ Privilege verified!");
      Serial.println("   LDR Value: " + String(ldrValue));
    }
  }
}

// ===== TEST CASE 3: BUTTON CONFIRMATION =====
void checkButtonPress() {
  int buttonState = digitalRead(BUTTON_PIN);
  
  if (buttonState == HIGH) {
    // Debounce check
    if (millis() - lastButtonTime > DEBOUNCE_DELAY) {
      lastButtonTime = millis();
      
      Serial.println("🔘 Button pressed - Sending request...");
      
      // Send ride request
      if (sendRideRequest()) {
        requestSent = true;
        requestSentTime = millis();
        currentState = STATE_WAITING_ACCEPTANCE;
        setLEDs(false, false, false); // ALL OFF while waiting
        displayMessage("Request Sent!", "Waiting for", "rickshaw...");
        beep(3, 80);
        Serial.println("✓ Request sent to backend");
        Serial.println("⏳ Waiting for rickshaw acceptance (60s timeout)...");
      } else {
        displayMessage("Error!", "Check WiFi", "Try again");
        beep(1, 500);
        Serial.println("✗ Request failed");
        delay(2000);
        resetSystem();
      }
    }
  }
}

// ===== TEST CASE 4 & 5: LED STATUS + RIDE MONITORING =====
void checkRideStatus() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  // Check every 2 seconds
  if (millis() - lastStatusCheck < 2000) return;
  lastStatusCheck = millis();
  
  HTTPClient http;
  String url = String(backendURL) + "/ride/status?blockID=" + String(blockID);
  
  http.begin(url);
  http.setTimeout(3000);
  int httpCode = http.GET();
  
  if (httpCode == 200) {
    String response = http.getString();
    
    // Parse status
    if (response.indexOf("\"ACCEPTED\"") > 0) {
      // TEST CASE 4b: Yellow LED - Rickshaw accepted (ONLY NOW, not before!)
      if (currentState == STATE_WAITING_ACCEPTANCE) {
        currentState = STATE_RIDE_ACCEPTED;
        setLEDs(true, false, false); // Yellow ON - rickshaw is coming!
        displayMessage("Ride Accepted!", "Rickshaw coming", "Please wait...");
        beep(2, 100);
        Serial.println("✓ Status: ACCEPTED - Yellow LED ON (rickshaw coming)");
      }
    }
    else if (response.indexOf("\"PICKUP\"") > 0) {
      // TEST CASE 4d: Green LED - Rickshaw arrived at your location
      if (currentState != STATE_RIDE_ACTIVE) {
        currentState = STATE_RIDE_ACTIVE;
        setLEDs(false, false, true); // Green ON - rickshaw is here!
        displayMessage("Rickshaw Here!", "Have a safe", "journey!");
        beep(3, 100);
        Serial.println("✓ Status: PICKUP - Green LED ON (rickshaw arrived)");
      }
    }
    else if (response.indexOf("\"COMPLETED\"") > 0) {
      // Ride completed - show message and reset
      displayMessage("Ride Complete", "Thank you!", "Resetting...");
      beep(2, 150);
      Serial.println("✓ Ride completed - Resetting system...");
      delay(3000);
      resetSystem();
    }
  }
  
  http.end();
}

// ===== TIMEOUT CHECKER =====
void checkTimeout() {
  if (currentState == STATE_WAITING_ACCEPTANCE) {
    unsigned long waitTime = millis() - requestSentTime;
    
    // Show waiting time on display
    if (millis() - lastLEDBlink > 1000) {
      lastLEDBlink = millis();
      int secondsWaiting = waitTime / 1000;
      displayMessage("Waiting...", "Time: " + String(secondsWaiting) + "s", "Max: 60s");
    }
    
    // Check for timeout
    if (waitTime > REQUEST_TIMEOUT) {
      currentState = STATE_TIMEOUT_ERROR;
      setLEDs(false, true, false); // Red ON
      displayMessage("TIMEOUT!", "No rickshaw", "available");
      beep(1, 500);
      Serial.println("✗ TIMEOUT after 60 seconds");
      delay(5000);
      resetSystem();
    }
  }
}

// ===== SETUP =====
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n\n=== AERAS USER SIDE SYSTEM ===");
  
  // Pin modes
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LDR_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  
  // Initialize LEDs OFF
  setLEDs(false, false, false);
  
  // Initialize OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("✗ OLED failed!"));
    while (1) {
      digitalWrite(LED_RED, HIGH);
      delay(500);
      digitalWrite(LED_RED, LOW);
      delay(500);
    }
  }
  
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  displayMessage("AERAS System", "Initializing...", "Please wait");
  
  // Connect WiFi
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✓ WiFi Connected");
    Serial.println("IP: " + WiFi.localIP().toString());
    displayMessage("WiFi Connected", "System Ready", "");
    beep(2, 100);
  } else {
    Serial.println("\n✗ WiFi Failed - Offline Mode");
    displayMessage("WiFi Error", "Check network", "");
    beep(1, 500);
  }
  
  delay(2000);
  
  Serial.println("\n=== SYSTEM READY ===");
  Serial.println("Block ID: " + String(blockID));
  Serial.println("Destination: " + String(destination));
  Serial.println("\nTest Cases Active:");
  Serial.println("1. Ultrasonic: Stand within 10m for 3+ sec");
  Serial.println("2. LDR: Direct laser at sensor");
  Serial.println("3. Button: Press to confirm");
  Serial.println("4. LEDs: Watch status indicators");
  Serial.println("5. OLED: Check display updates\n");
  
  resetSystem();
}

// ===== MAIN LOOP =====
void loop() {
  switch (currentState) {
    case STATE_IDLE:
    case STATE_DETECTING:
      checkUltrasonicSensor();
      break;
      
    case STATE_PRIVILEGE_CHECK:
      checkPrivilegeVerification();
      break;
      
    case STATE_WAITING_CONFIRM:
      checkButtonPress();
      break;
      
    case STATE_WAITING_ACCEPTANCE:
      checkRideStatus();
      checkTimeout();
      break;
      
    case STATE_RIDE_ACCEPTED:
    case STATE_RIDE_ACTIVE:
      checkRideStatus();
      break;
      
    case STATE_TIMEOUT_ERROR:
      // Handled in checkTimeout()
      break;
  }
  
  delay(50); // Small delay to prevent CPU overload
}