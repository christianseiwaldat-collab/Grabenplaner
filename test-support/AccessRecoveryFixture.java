// Synthetic qualification writer only; never shipped or invoked by the app.
// The caller authenticates the pinned Jackcess/JRE closure before compilation.
import com.google.gson.*;
import com.healthmarketscience.jackcess.*;
import java.io.*;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.LocalDateTime;
import java.util.HashSet;

public final class AccessRecoveryFixture {
  private static DataType type(String name) {
    switch(name) {
      case "boolean": return DataType.BOOLEAN;
      case "byte": return DataType.BYTE;
      case "integer": return DataType.INT;
      case "long": return DataType.LONG;
      case "float": return DataType.FLOAT;
      case "double": return DataType.DOUBLE;
      case "currency": return DataType.MONEY;
      case "datetime": return DataType.SHORT_DATE_TIME;
      case "text": return DataType.TEXT;
      case "memo": return DataType.MEMO;
      case "repid": return DataType.GUID;
      default: throw new IllegalArgumentException("UNREVIEWED_SYNTHETIC_COLUMN");
    }
  }
  private static Object value(JsonElement input, String type) {
    if(input == null || input.isJsonNull()) return "boolean".equals(type) ? Boolean.FALSE : null;
    switch(type) {
      case "boolean": return input.getAsBoolean();
      case "byte": case "integer": case "long": return input.getAsInt();
      case "float": return input.getAsFloat();
      case "double": return input.getAsDouble();
      case "currency": return new BigDecimal(input.getAsString());
      case "datetime": return LocalDateTime.parse(input.getAsString());
      case "text": case "memo": case "repid": return input.getAsString();
      default: throw new IllegalArgumentException("UNREVIEWED_SYNTHETIC_VALUE");
    }
  }
  public static void main(String[] args) throws Exception {
    if(args.length != 2) throw new IllegalArgumentException("FIXTURE_ARGUMENTS");
    Path spec = Paths.get(args[0]).toAbsolutePath().normalize(), target = Paths.get(args[1]).toAbsolutePath().normalize();
    String file = target.getFileName().toString();
    if(!file.matches("synthetic-(trade|cash|bestell|weum|inventur|lieferantenrechnungen)\\.accdb")
      || !Files.isRegularFile(spec) || Files.isSymbolicLink(spec) || Files.size(spec) > 1024 * 1024 || Files.exists(target)
      || !target.getParent().equals(spec.getParent()) || !target.getParent().toRealPath().equals(target.getParent())) throw new IllegalArgumentException("FIXTURE_BOUNDARY");
    JsonObject definition;
    try(Reader reader = Files.newBufferedReader(spec, StandardCharsets.UTF_8)) { definition = JsonParser.parseReader(reader).getAsJsonObject(); }
    JsonArray tables = definition.getAsJsonArray("tables");
    if(tables.size() < 1 || tables.size() > 150) throw new IllegalArgumentException("FIXTURE_TABLE_SET");
    int rows = 0; HashSet<String> names = new HashSet<>();
    try(Database database = new DatabaseBuilder(target.toFile()).setFileFormat(Database.FileFormat.V2010).setAutoSync(false).create()) {
      database.setDateTimeType(DateTimeType.LOCAL_DATE_TIME); database.setEvaluateExpressions(false);
      for(JsonElement tableValue : tables) {
        JsonObject tableSpec = tableValue.getAsJsonObject(); String name = tableSpec.get("name").getAsString();
        if(name.length() < 1 || name.length() > 64 || !names.add(name)) throw new IllegalArgumentException("FIXTURE_TABLE_NAME");
        TableBuilder builder = new TableBuilder(name); JsonArray columns = tableSpec.getAsJsonArray("columns");
        if(columns.size() < 1 || columns.size() > 255) throw new IllegalArgumentException("FIXTURE_COLUMN_SET");
        for(JsonElement columnValue : columns) {
          JsonObject column = columnValue.getAsJsonObject(); DataType columnType = type(column.get("type").getAsString());
          ColumnBuilder field = new ColumnBuilder(column.get("name").getAsString(), columnType);
          if(columnType == DataType.TEXT) field.setLengthInUnits(255);
          builder.addColumn(field);
        }
        Table table = builder.toTable(database);
        for(JsonElement rowValue : tableSpec.getAsJsonArray("rows")) {
          if(++rows > 10000) throw new IllegalArgumentException("FIXTURE_ROW_LIMIT");
          JsonObject row = rowValue.getAsJsonObject(); Object[] values = new Object[columns.size()];
          for(int i = 0; i < columns.size(); i++) {
            JsonObject column = columns.get(i).getAsJsonObject(); values[i] = value(row.get(column.get("name").getAsString()), column.get("type").getAsString());
          }
          table.addRow(values);
        }
      }
      database.flush();
    }
    System.out.println("{\"syntheticAccessFile\":true,\"encryptedAccessFile\":false,\"tables\":" + tables.size() + ",\"rows\":" + rows + "}");
  }
}
