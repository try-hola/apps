<!DOCTYPE html>
<html>
<head>
    <title>PHP Environment Variables</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            color: #333;
        }
        h1 {
            color: #0066cc;
            border-bottom: 1px solid #eee;
            padding-bottom: 10px;
        }
        .env-container {
            background-color: #f8f9fa;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            padding: 20px;
            margin-top: 20px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #e1e4e8;
        }
        th {
            background-color: #f1f1f1;
            font-weight: 600;
        }
        tr:hover {
            background-color: #f6f8fa;
        }
        .system-info {
            margin-top: 30px;
            padding: 15px;
            background-color: #e8f4fc;
            border-radius: 8px;
        }
    </style>
</head>
<body>
    <h1>PHP Environment Variables</h1>
    
    <div class="env-container">
        <table>
            <thead>
                <tr>
                    <th>Variable Name</th>
                    <th>Value</th>
                </tr>
            </thead>
            <tbody>
                <?php
                $environment = getenv();
                ksort($environment);
                
                foreach ($environment as $key => $value) {
                    // Mask sensitive information in keys likely to contain secrets
                    $maskedValue = $value;
                    if (preg_match('/(password|secret|key|token|credential)/i', $key)) {
                        $maskedValue = substr($value, 0, 3) . '********';
                    }
                    
                    echo "<tr>";
                    echo "<td><strong>" . htmlspecialchars($key) . "</strong></td>";
                    echo "<td>" . htmlspecialchars($maskedValue) . "</td>";
                    echo "</tr>";
                }
                ?>
            </tbody>
        </table>
    </div>
    
    <div class="system-info">
        <h3>Server Information</h3>
        <p><strong>PHP Version:</strong> <?= phpversion() ?></p>
        <p><strong>Server Software:</strong> <?= $_SERVER['SERVER_SOFTWARE'] ?? 'PHP Development Server' ?></p>
        <p><strong>Server Time:</strong> <?= date('Y-m-d H:i:s') ?></p>
    </div>
</body>
</html>