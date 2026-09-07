// Standalone optional diagnostic; never part of the app or its dependencies.
// Jackcess 4.0.11, pure Java, explicit read-only file mode. No Access/ODBC/macros.
// Only aggregate counters leave the process; no source values or error messages.
import com.healthmarketscience.jackcess.Database;
import com.healthmarketscience.jackcess.DatabaseBuilder;
import com.healthmarketscience.jackcess.Row;
import com.healthmarketscience.jackcess.Table;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.logging.Level;
import java.util.logging.Logger;

class VerifyTradeFotoIndependentCount {
  static String hash(Path source) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (var stream = Files.newInputStream(source)) {
      byte[] bytes = new byte[1024 * 1024]; int length;
      while ((length = stream.read(bytes)) >= 0) digest.update(bytes, 0, length);
      java.util.Arrays.fill(bytes, (byte)0);
    }
    return HexFormat.of().formatHex(digest.digest());
  }
  public static void main(String[] args) throws Exception {
    if (args.length != 1) throw new IllegalArgumentException("SOURCE_REQUIRED");
    Path source = Path.of(args[0]).toRealPath();
    String before = hash(source);
    if (!before.equals("42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3")) throw new IllegalArgumentException("SOURCE_HASH_CHANGED");
    var modified = Files.getLastModifiedTime(source);
    Logger.getLogger("").setLevel(Level.OFF);
    long start = System.nanoTime(); boolean failed = false;
    try (Database db = new DatabaseBuilder(source.toFile()).setReadOnly(true).setAutoSync(false).open()) {
      db.setLinkResolver((from, name) -> { throw new java.io.IOException("LINKS_FORBIDDEN"); });
      for (String name : new String[]{"ARTIKEL_STAMM", "ARTIKEL_FILIALEN"}) {
        Table table = db.getTable(name); long count = 0;
        for (Row ignored : table) count++;
        System.out.println("{\"parser\":\"Jackcess 4.0.11\",\"readOnly\":true,\"accessEngine\":false,\"table\":\"" + name
          + "\",\"declared\":" + table.getRowCount() + ",\"enumeratedRows\":" + count + "}");
      }
    } catch (Exception error) {
      failed = true;
      System.out.println("{\"status\":\"failed\",\"errorType\":\"" + error.getClass().getSimpleName() + "\"}");
    } finally {
      boolean unchanged = before.equals(hash(source)) && modified.equals(Files.getLastModifiedTime(source));
      System.out.println("{\"sourceUnchanged\":" + unchanged + ",\"fileSha256\":\"" + before + "\",\"durationMs\":" + ((System.nanoTime() - start) / 1000000) + "}");
      if (!unchanged) throw new IllegalStateException("SOURCE_CHANGED");
    }
    if (failed) throw new IllegalStateException("INDEPENDENT_COUNT_FAILED");
  }
}
