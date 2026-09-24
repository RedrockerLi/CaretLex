#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_OUTLINE_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct {
    FILE *file;
    double x_offset;
    int contour_open;
} PathSink;

static void coordinate(FILE *file, double value) {
    fprintf(file, "%.3f", value);
}

static int move_to(const FT_Vector *to, void *user) {
    PathSink *sink = (PathSink *)user;
    if (sink->contour_open) fprintf(sink->file, "Z ");
    sink->contour_open = 1;
    fprintf(sink->file, "M "); coordinate(sink->file, to->x + sink->x_offset);
    fputc(' ', sink->file); coordinate(sink->file, to->y); fputc(' ', sink->file);
    return 0;
}

static int line_to(const FT_Vector *to, void *user) {
    PathSink *sink = (PathSink *)user;
    fprintf(sink->file, "L "); coordinate(sink->file, to->x + sink->x_offset);
    fputc(' ', sink->file); coordinate(sink->file, to->y); fputc(' ', sink->file);
    return 0;
}

static int conic_to(const FT_Vector *control, const FT_Vector *to, void *user) {
    PathSink *sink = (PathSink *)user;
    fprintf(sink->file, "Q "); coordinate(sink->file, control->x + sink->x_offset);
    fputc(' ', sink->file); coordinate(sink->file, control->y); fputc(' ', sink->file);
    coordinate(sink->file, to->x + sink->x_offset); fputc(' ', sink->file);
    coordinate(sink->file, to->y); fputc(' ', sink->file);
    return 0;
}

static int cubic_to(const FT_Vector *c1, const FT_Vector *c2, const FT_Vector *to, void *user) {
    PathSink *sink = (PathSink *)user;
    fprintf(sink->file, "C "); coordinate(sink->file, c1->x + sink->x_offset);
    fputc(' ', sink->file);
    coordinate(sink->file, c1->y); fputc(' ', sink->file);
    coordinate(sink->file, c2->x + sink->x_offset); fputc(' ', sink->file);
    coordinate(sink->file, c2->y); fputc(' ', sink->file);
    coordinate(sink->file, to->x + sink->x_offset); fputc(' ', sink->file);
    coordinate(sink->file, to->y); fputc(' ', sink->file);
    return 0;
}


int main(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr, "usage: %s FONT SIZE X BASELINE SPLIT_INDEX\n", argv[0]);
        return 2;
    }
    const char *font_path = argv[1];
    double font_size = atof(argv[2]);
    double x = atof(argv[3]);
    double baseline = atof(argv[4]);
    int split_index = atoi(argv[5]);
    const char *text = "CaretLex";
    const int length = (int)strlen(text);
    if (font_size <= 0 || split_index < 1 || split_index >= length) {
        fprintf(stderr, "invalid size or split index\n");
        return 2;
    }

    FT_Library library;
    FT_Face face;
    if (FT_Init_FreeType(&library) || FT_New_Face(library, font_path, 0, &face)) {
        fprintf(stderr, "could not load font: %s\n", font_path);
        return 1;
    }

    FILE *caret_path = tmpfile();
    FILE *lex_path = tmpfile();
    if (!caret_path || !lex_path) return 1;
    PathSink sinks[2] = {{caret_path, 0, 0}, {lex_path, 0, 0}};
    FT_Outline_Funcs callbacks = {move_to, line_to, conic_to, cubic_to, 0, 0};
    FT_UInt previous = 0;
    FT_Pos pen = 0;
    FT_Pos split_x = 0;

    for (int i = 0; i < length; ++i) {
        FT_UInt glyph = FT_Get_Char_Index(face, (FT_ULong)(unsigned char)text[i]);
        if (previous && glyph && FT_HAS_KERNING(face)) {
            FT_Vector kerning;
            if (!FT_Get_Kerning(face, previous, glyph, FT_KERNING_UNSCALED, &kerning)) pen += kerning.x;
        }
        if (i == split_index) split_x = pen;
        int part = i < split_index ? 0 : 1;
        sinks[part].x_offset = (double)(part ? pen - split_x : pen);
        if (FT_Load_Glyph(face, glyph, FT_LOAD_NO_SCALE | FT_LOAD_NO_HINTING | FT_LOAD_NO_BITMAP)) {
            fprintf(stderr, "could not load glyph %c\n", text[i]); return 1;
        }
        if (face->glyph->format == FT_GLYPH_FORMAT_OUTLINE) {
            if (FT_Outline_Decompose(&face->glyph->outline, &callbacks, &sinks[part])) {
                fprintf(stderr, "could not decompose glyph %c\n", text[i]); return 1;
            }
            if (sinks[part].contour_open) { fprintf(sinks[part].file, "Z "); sinks[part].contour_open = 0; }
        }
        pen += face->glyph->metrics.horiAdvance;
        previous = glyph;
    }
    double scale = font_size / face->units_per_EM;
    fprintf(stdout, "<!-- Inter SemiBold outline; UPM=%u; width=%.3fpx; Lex offset=%.3fpx -->\n",
            face->units_per_EM, pen * scale, split_x * scale);
    fprintf(stdout, "<g transform=\"translate(%.2f %.2f) scale(%.8f %.8f)\">\n",
            x, baseline, scale, -scale);
    fprintf(stdout, "  <path fill=\"var(--wordmark-primary)\" d=\"");
    rewind(caret_path); int ch; while ((ch = fgetc(caret_path)) != EOF) fputc(ch, stdout);
    fprintf(stdout, "\"/>\n  <path fill=\"var(--wordmark-accent)\" transform=\"translate(%.3f 0)\" d=\"", (double)split_x);
    rewind(lex_path); while ((ch = fgetc(lex_path)) != EOF) fputc(ch, stdout);
    fprintf(stdout, "\"/>\n</g>\n");

    fclose(caret_path); fclose(lex_path);
    FT_Done_Face(face); FT_Done_FreeType(library);
    return 0;
}
