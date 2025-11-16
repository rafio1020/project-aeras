// AERAS Backend Server - FIXED VERSION
// All test cases 8-12 with proper error handling

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(cors());
app.use(express.json());

// ========== DATABASE ==========
const db = new sqlite3.Database('./aeras.db', (err) => {
  if (err) {
    console.error('✗ Database error:', err);
  } else {
    console.log('✓ Database connected');
  }
});

// Create schema
db.serialize(() => {
  // Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    userID TEXT PRIMARY KEY,
    name TEXT,
    phoneNumber TEXT,
    privilege BOOLEAN DEFAULT 1,
    totalRides INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Rickshaws
  db.run(`CREATE TABLE IF NOT EXISTS rickshaws (
    rickshawID TEXT PRIMARY KEY,
    pullerName TEXT NOT NULL,
    phoneNumber TEXT,
    currentLat REAL DEFAULT 0,
    currentLng REAL DEFAULT 0,
    isOnline BOOLEAN DEFAULT 1,
    totalPoints INTEGER DEFAULT 0,
    status TEXT DEFAULT 'AVAILABLE',
    lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK(status IN ('AVAILABLE', 'ON_RIDE', 'OFFLINE'))
  )`);
  
  // Rides
  db.run(`CREATE TABLE IF NOT EXISTS rides (
    rideID INTEGER PRIMARY KEY AUTOINCREMENT,
    userID TEXT NOT NULL,
    rickshawID TEXT,
    pickupBlock TEXT NOT NULL,
    destination TEXT NOT NULL,
    requestTime DATETIME DEFAULT CURRENT_TIMESTAMP,
    acceptTime DATETIME,
    pickupTime DATETIME,
    dropTime DATETIME,
    status TEXT DEFAULT 'PENDING',
    dropLat REAL,
    dropLng REAL,
    dropDistance REAL,
    pointsAwarded INTEGER DEFAULT 0,
    CHECK(status IN ('PENDING', 'ACCEPTED', 'PICKUP', 'COMPLETED', 'TIMEOUT', 'PENDING_REVIEW', 'CANCELLED')),
    FOREIGN KEY(userID) REFERENCES users(userID),
    FOREIGN KEY(rickshawID) REFERENCES rickshaws(rickshawID)
  )`);
  
  // Locations (TEST CASE 7: Exact coordinates from rubric)
  db.run(`CREATE TABLE IF NOT EXISTS locations (
    blockID TEXT PRIMARY KEY,
    locationName TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL
  )`);
  
  // Points History (TEST CASE 11)
  db.run(`CREATE TABLE IF NOT EXISTS points_history (
    historyID INTEGER PRIMARY KEY AUTOINCREMENT,
    rickshawID TEXT NOT NULL,
    rideID INTEGER,
    pointsEarned INTEGER DEFAULT 0,
    pointsSpent INTEGER DEFAULT 0,
    transactionType TEXT,
    transactionDate DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    CHECK(transactionType IN ('EARNED', 'SPENT', 'ADJUSTED', 'EXPIRED')),
    FOREIGN KEY(rickshawID) REFERENCES rickshaws(rickshawID),
    FOREIGN KEY(rideID) REFERENCES rides(rideID)
  )`);
  
  // Indexes for performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rides_time ON rides(requestTime DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rickshaw_status ON rickshaws(status, isOnline)`);
  
  // Insert exact locations from TEST CASE 7
  const locations = [
    ['CUET_CAMPUS', 'CUET Campus', 22.4633, 91.9714],
    ['PAHARTOLI', 'Pahartoli', 22.4725, 91.9845],
    ['NOAPARA', 'Noapara', 22.4580, 91.9920],
    ['RAOJAN', 'Raojan', 22.4520, 91.9650]
  ];
  
  const stmt = db.prepare('INSERT OR IGNORE INTO locations VALUES (?, ?, ?, ?)');
  locations.forEach(loc => stmt.run(loc));
  stmt.finalize();
  
  console.log('✓ Database schema created');
});

// ========== HELPER FUNCTIONS ==========

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  
  return R * c; // meters
}

// TEST CASE 7: Point calculation formula from rubric
function calculatePoints(distanceMeters) {
  const basePoints = 10;
  
  // TEST CASE 7a: Exact location (0m) = 10 points
  if (distanceMeters <= 0) return 10;
  
  // TEST CASE 7b: Within 50m = 8-10 points (partial reward)
  if (distanceMeters <= 50) {
    const penalty = Math.floor(distanceMeters / 10);
    return Math.max(basePoints - penalty, 8);
  }
  
  // TEST CASE 7c: 51-100m = 5 points (reduced reward)
  if (distanceMeters <= 100) {
    return 5;
  }
  
  // TEST CASE 7d: >100m = 0 points (pending review)
  return 0;
}

// ========== USER SIDE ENDPOINTS ==========

// 1. RIDE REQUEST
app.post('/api/ride/request', (req, res) => {
  const { blockID, destination, userID = 'GUEST' } = req.body;
  
  console.log(`\n📍 NEW RIDE REQUEST: ${blockID} → ${destination}`);
  
  if (!blockID || !destination) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Insert ride
  db.run(
    `INSERT INTO rides (userID, pickupBlock, destination, status) 
     VALUES (?, ?, ?, 'PENDING')`,
    [userID, blockID, destination],
    function(err) {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: err.message });
      }
      
      const rideID = this.lastID;
      console.log(`✓ Ride created: ID ${rideID}`);
      
      // TEST CASE 8d: Set timeout for 60 seconds
      setTimeout(() => {
        db.get('SELECT status FROM rides WHERE rideID = ?', [rideID], (err, row) => {
          if (row && row.status === 'PENDING') {
            db.run('UPDATE rides SET status = "TIMEOUT" WHERE rideID = ?', [rideID]);
            console.log(`⏱ Ride ${rideID} TIMEOUT (60s expired)`);
          }
        });
      }, 60000);
      
      res.json({ 
        success: true, 
        rideID: rideID,
        message: 'Ride request sent' 
      });
    }
  );
});

// 2. GET RIDE STATUS (TEST CASE 4: For LED updates)
app.get('/api/ride/status', (req, res) => {
  const { blockID } = req.query;
  
  if (!blockID) {
    return res.status(400).json({ error: 'blockID required' });
  }
  
  db.get(
    `SELECT * FROM rides 
     WHERE pickupBlock = ? 
     AND status IN ('PENDING', 'ACCEPTED', 'PICKUP', 'TIMEOUT') 
     ORDER BY requestTime DESC 
     LIMIT 1`,
    [blockID],
    (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      if (!row) {
        return res.json({ status: 'IDLE' });
      }
      
      res.json({ 
        status: row.status,
        rideID: row.rideID,
        rickshawID: row.rickshawID
      });
    }
  );
});

// ========== RICKSHAW SIDE ENDPOINTS ==========

// 3. REGISTER RICKSHAW
app.post('/api/rickshaw/register', (req, res) => {
  const { rickshawID, pullerName, phoneNumber, currentLat, currentLng } = req.body;
  
  console.log(`🛺 Registering: ${rickshawID}`);
  
  db.run(
    `INSERT OR REPLACE INTO rickshaws 
     (rickshawID, pullerName, phoneNumber, currentLat, currentLng, isOnline, lastUpdated) 
     VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
    [rickshawID, pullerName, phoneNumber, currentLat, currentLng],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      console.log(`✓ ${rickshawID} registered`);
      res.json({ success: true });
    }
  );
});

// 4. GET PENDING RIDES (TEST CASE 8: Alert distribution with proximity)
app.get('/api/ride/pending', (req, res) => {
  const { rickshawID } = req.query;
  
  if (!rickshawID) {
    return res.status(400).json({ error: 'rickshawID required' });
  }
  
  // Get rickshaw location
  db.get('SELECT currentLat, currentLng FROM rickshaws WHERE rickshawID = ?', 
    [rickshawID], 
    (err, rickshaw) => {
      if (err || !rickshaw) {
        return res.json({ rides: [] });
      }
      
      // TEST CASE 8a: Get all pending rides with location
      db.all(
        `SELECT r.*, l.latitude, l.longitude, l.locationName 
         FROM rides r 
         JOIN locations l ON r.pickupBlock = l.blockID 
         WHERE r.status = 'PENDING' 
         ORDER BY r.requestTime ASC`,
        (err, rows) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          
          // TEST CASE 8b: Calculate distances and sort by proximity
          const ridesWithDistance = rows.map(ride => {
            const distance = calculateDistance(
              rickshaw.currentLat, rickshaw.currentLng,
              ride.latitude, ride.longitude
            );
            return { 
              ...ride, 
              distance: (distance / 1000).toFixed(2) // km
            };
          }).sort((a, b) => parseFloat(a.distance) - parseFloat(b.distance));
          
          res.json({ rides: ridesWithDistance });
        }
      );
    }
  );
});

// 5. ACCEPT RIDE (TEST CASE 8c: First-accept wins with race condition handling)
app.post('/api/ride/accept', (req, res) => {
  const { rideID, rickshawID } = req.body;
  
  if (!rideID || !rickshawID) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  console.log(`\n🤝 ${rickshawID} attempting to accept ride ${rideID}`);
  
  // FIXED: Use transaction to handle race condition
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    // Check if still pending
    db.get('SELECT status FROM rides WHERE rideID = ?', [rideID], (err, ride) => {
      if (err) {
        db.run('ROLLBACK');
        return res.status(500).json({ error: err.message });
      }
      
      if (!ride || ride.status !== 'PENDING') {
        db.run('ROLLBACK');
        console.log(`✗ Ride ${rideID} already taken`);
        return res.json({ 
          success: false, 
          message: 'Ride already taken by another puller' 
        });
      }
      
      // Accept ride (atomic)
      db.run(
        `UPDATE rides 
         SET status = 'ACCEPTED', 
             rickshawID = ?, 
             acceptTime = CURRENT_TIMESTAMP 
         WHERE rideID = ? AND status = 'PENDING'`,
        [rickshawID, rideID],
        function(err) {
          if (err) {
            db.run('ROLLBACK');
            return res.status(500).json({ error: err.message });
          }
          
          if (this.changes === 0) {
            db.run('ROLLBACK');
            return res.json({ success: false, message: 'Race condition' });
          }
          
          // Update rickshaw status
          db.run('UPDATE rickshaws SET status = "ON_RIDE" WHERE rickshawID = ?', [rickshawID]);
          
          db.run('COMMIT');
          console.log(`✓ Ride ${rideID} accepted by ${rickshawID}`);
          res.json({ success: true, rideID: rideID });
        }
      );
    });
  });
});

// 6. CONFIRM PICKUP (TEST CASE 9: Status sync)
app.post('/api/ride/pickup', (req, res) => {
  const { rideID } = req.body;
  
  if (!rideID) {
    return res.status(400).json({ error: 'rideID required' });
  }
  
  console.log(`\n🚗 Pickup confirmed for ride ${rideID}`);
  
  db.run(
    `UPDATE rides 
     SET status = 'PICKUP', 
         pickupTime = CURRENT_TIMESTAMP 
     WHERE rideID = ? AND status = 'ACCEPTED'`,
    [rideID],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      if (this.changes === 0) {
        return res.status(400).json({ error: 'Ride not in accepted state' });
      }
      
      console.log(`✓ Pickup confirmed`);
      res.json({ success: true });
    }
  );
});

// 7. COMPLETE RIDE (TEST CASE 7: GPS verification + Point allocation)
app.post('/api/ride/complete', (req, res) => {
  const { rideID, dropLat, dropLng } = req.body;
  
  if (!rideID || dropLat === undefined || dropLng === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  console.log(`\n🏁 Completing ride ${rideID}`);
  console.log(`   Drop location: ${dropLat}, ${dropLng}`);
  
  // Get ride with destination coordinates
  db.get(
    `SELECT r.*, l.latitude as destLat, l.longitude as destLng, l.locationName 
     FROM rides r 
     JOIN locations l ON r.destination = l.blockID 
     WHERE r.rideID = ?`,
    [rideID],
    (err, ride) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      if (!ride) {
        return res.status(404).json({ error: 'Ride not found' });
      }
      
      // TEST CASE 7: Calculate distance from destination
      const distanceFromDest = calculateDistance(
        dropLat, dropLng, 
        ride.destLat, ride.destLng
      );
      
      console.log(`   Target: ${ride.locationName} (${ride.destLat}, ${ride.destLng})`);
      console.log(`   Distance from destination: ${distanceFromDest.toFixed(2)} m`);
      
      // TEST CASE 7: Calculate points
      const points = calculatePoints(distanceFromDest);
      const status = distanceFromDest <= 100 ? 'COMPLETED' : 'PENDING_REVIEW';
      
      console.log(`   Points awarded: ${points}`);
      console.log(`   Status: ${status}`);
      
      if (status === 'PENDING_REVIEW') {
        console.log(`   ⚠ Distance > 100m - Requires admin review`);
      }
      
      // Update ride
      db.run(
        `UPDATE rides 
         SET status = ?, 
             dropTime = CURRENT_TIMESTAMP, 
             dropLat = ?, 
             dropLng = ?, 
             dropDistance = ?,
             pointsAwarded = ? 
         WHERE rideID = ?`,
        [status, dropLat, dropLng, distanceFromDest, points, rideID],
        (err) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          
          // TEST CASE 11: Award points
          if (points > 0) {
            db.run(
              'UPDATE rickshaws SET totalPoints = totalPoints + ?, status = "AVAILABLE" WHERE rickshawID = ?', 
              [points, ride.rickshawID]
            );
            
            db.run(
              `INSERT INTO points_history (rickshawID, rideID, pointsEarned, transactionType, notes) 
               VALUES (?, ?, ?, 'EARNED', ?)`,
              [ride.rickshawID, rideID, points, `Ride completed - ${distanceFromDest.toFixed(1)}m from target`]
            );
          } else {
            db.run('UPDATE rickshaws SET status = "AVAILABLE" WHERE rickshawID = ?', [ride.rickshawID]);
          }
          
          console.log(`✓ Ride completed`);
          
          res.json({ 
            success: true, 
            points: points,
            distance: distanceFromDest.toFixed(2),
            status: status
          });
        }
      );
    }
  );
});

// 8. UPDATE RICKSHAW LOCATION (TEST CASE 9: Real-time sync)
app.post('/api/rickshaw/location', (req, res) => {
  const { rickshawID, lat, lng } = req.body;
  
  if (!rickshawID || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  db.run(
    'UPDATE rickshaws SET currentLat = ?, currentLng = ?, lastUpdated = CURRENT_TIMESTAMP WHERE rickshawID = ?',
    [lat, lng, rickshawID],
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    }
  );
});

// ========== ADMIN ENDPOINTS (TEST CASE 10) ==========

// 9. ADMIN DASHBOARD STATS
app.get('/api/admin/stats', (req, res) => {
  const stats = {};
  
  db.get('SELECT COUNT(*) as count FROM rides WHERE status IN ("ACCEPTED", "PICKUP")', (err, row) => {
    stats.activeRides = row ? row.count : 0;
    
    db.get('SELECT COUNT(*) as count FROM rickshaws WHERE isOnline = 1', (err, row) => {
      stats.onlineRickshaws = row ? row.count : 0;
      
      db.get('SELECT COUNT(*) as count FROM rides WHERE status = "PENDING_REVIEW"', (err, row) => {
        stats.pendingReviews = row ? row.count : 0;
        
        db.get('SELECT SUM(pointsAwarded) as total FROM rides WHERE DATE(dropTime) = DATE("now")', (err, row) => {
          stats.pointsToday = row ? row.total || 0 : 0;
          
          db.get('SELECT COUNT(*) as count FROM rides WHERE DATE(requestTime) = DATE("now")', (err, row) => {
            stats.ridesToday = row ? row.count : 0;
            
            res.json(stats);
          });
        });
      });
    });
  });
});

// 10. ADMIN GET ALL RIDES
app.get('/api/admin/rides', (req, res) => {
  const { limit = 100, status } = req.query;
  
  let query = `
    SELECT r.*, rick.pullerName 
    FROM rides r 
    LEFT JOIN rickshaws rick ON r.rickshawID = rick.rickshawID
  `;
  
  const params = [];
  
  if (status) {
    query += ' WHERE r.status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY r.requestTime DESC LIMIT ?';
  params.push(parseInt(limit));
  
  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ rides: rows });
  });
});

// 11. ADMIN ADJUST POINTS (TEST CASE 11)
app.post('/api/admin/adjust-points', (req, res) => {
  const { rideID, newPoints, reason = 'Admin adjustment' } = req.body;
  
  if (!rideID || newPoints === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  console.log(`\n👨‍💼 Admin adjusting points for ride ${rideID} to ${newPoints}`);
  
  db.get('SELECT rickshawID, pointsAwarded FROM rides WHERE rideID = ?', [rideID], (err, ride) => {
    if (err || !ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }
    
    const pointDiff = newPoints - ride.pointsAwarded;
    
    db.run('UPDATE rides SET pointsAwarded = ?, status = "COMPLETED" WHERE rideID = ?', [newPoints, rideID], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      db.run('UPDATE rickshaws SET totalPoints = totalPoints + ? WHERE rickshawID = ?', [pointDiff, ride.rickshawID]);
      
      db.run(
        `INSERT INTO points_history (rickshawID, rideID, pointsEarned, transactionType, notes) 
         VALUES (?, ?, ?, 'ADJUSTED', ?)`,
        [ride.rickshawID, rideID, pointDiff, reason]
      );
      
      console.log(`✓ Points adjusted: ${ride.pointsAwarded} → ${newPoints} (${pointDiff >= 0 ? '+' : ''}${pointDiff})`);
      
      res.json({ success: true, pointDiff: pointDiff });
    });
  });
});

// 12. ADMIN ANALYTICS (TEST CASE 10c)
app.get('/api/admin/analytics', (req, res) => {
  const analytics = {};
  
  db.all(
    `SELECT destination, COUNT(*) as count 
     FROM rides 
     WHERE status != 'TIMEOUT' 
     GROUP BY destination 
     ORDER BY count DESC 
     LIMIT 5`,
    (err, rows) => {
      analytics.topDestinations = rows || [];
      
      db.all(
        `SELECT rickshawID, pullerName, totalPoints, 
                (SELECT COUNT(*) FROM rides WHERE rickshawID = rickshaws.rickshawID AND status = 'COMPLETED') as completedRides
         FROM rickshaws 
         ORDER BY totalPoints DESC 
         LIMIT 10`,
        (err, rows) => {
          analytics.topPullers = rows || [];
          
          res.json(analytics);
        }
      );
    }
  );
});

app.use(express.static('public')); // Create 'public' folder

app.get('/rickshaw', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'rickshaw-ui.html'));
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   AERAS Backend Server - FIXED VERSION    ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║   Server: http://localhost:${PORT}           ║`);
  console.log('║                                            ║');
  console.log('║   Test Cases Implemented:                  ║');
  console.log('║   ✓ TC8: Ride alert distribution          ║');
  console.log('║   ✓ TC9: Real-time synchronization        ║');
  console.log('║   ✓ TC10: Admin dashboard                 ║');
  console.log('║   ✓ TC11: Point management                ║');
  console.log('║   ✓ TC12: Database design                 ║');
  console.log('╚════════════════════════════════════════════╝\n');
});